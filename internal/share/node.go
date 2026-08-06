// Package share discovers other yv instances on the local network and streams
// project config between them.
//
// Scope: this is LAN-only, by mDNS. There is deliberately no rendezvous server,
// so there is also no way to discover a peer that is not on your network —
// hole punching and circuit relay would be dead weight without one, and are not
// enabled. "Nearby devices" means exactly that.
//
// Two things about the transport are worth knowing before reading on:
//
// libp2p's mDNS TXT records carry only dnsaddr= multiaddrs, and the advertised
// instance name is a random string, not the hostname. So a peer's display name
// and whether it requires a PIN cannot ride along with discovery; they are
// fetched over a small /yv/hello/1.0.0 stream once we connect.
//
// Because that hello requires a connection, we hold connections to discovered
// peers open (ConnManager.Protect) rather than letting the connection manager
// trim them. That makes a disconnect a meaningful signal — but not a conclusive
// one, so a disconnect triggers a re-dial probe rather than immediate removal.
package share

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	mdns "github.com/libp2p/go-libp2p/p2p/discovery/mdns"
	ma "github.com/multiformats/go-multiaddr"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"yv/internal/models"
)

const (
	// ServiceTag is the mDNS service name. Distinct from libp2p's default
	// "_p2p._udp" so we only ever find other yv instances.
	ServiceTag = "_yv-share"

	// HelloProto exchanges display metadata that mDNS cannot carry.
	HelloProto protocol.ID = "/yv/hello/1.0.0"

	// ShareProto carries a config transfer.
	ShareProto protocol.ID = "/yv/share/1.0.0"

	// connTag marks discovered peers as protected from connection trimming.
	connTag = "yv-peer"
)

const (
	// PeerTTL is how long a peer survives without being re-announced by mDNS.
	//
	// zeroconf's browse re-queries with exponential backoff capped at 60s, so a
	// live peer refreshes itself at least once a minute — five minutes leaves
	// 5x headroom, and a device that briefly drops off Wi-Fi keeps its
	// dinosaur instead of flickering out and back.
	//
	// The cost is a ghost: a peer that vanished without a disconnect can linger
	// for up to PeerTTL. Tapping a ghost fails the dial and surfaces as
	// "connection lost", which is a better outcome than a twitchy map.
	PeerTTL = 5 * time.Minute

	// sweepInterval is how often expired peers are reaped.
	sweepInterval = 60 * time.Second

	// probeDelay is the settle time before a disconnected peer is re-dialled.
	// Short enough to feel immediate when someone quits the app, long enough
	// that a transport blip does not evict a live peer.
	probeDelay = 2 * time.Second

	// probeTimeout bounds the confirming dial.
	probeTimeout = 4 * time.Second

	// helloTimeout bounds the metadata fetch. A peer that cannot answer this
	// quickly on a LAN is not one we can usefully show.
	helloTimeout = 6 * time.Second
)

// Events emitted to the frontend.
const (
	EventPeerFound = "peer:found"
	EventPeerLost  = "peer:lost"
	EventIncoming  = "share:incoming"
	EventImported  = "share:imported"
	EventError     = "share:error"
)

// hello is the metadata a peer serves about itself.
type hello struct {
	Name        string `json:"name"`
	PINRequired bool   `json:"pinRequired"`
}

// peerRec is a discovered peer and the bookkeeping that decides when it dies.
type peerRec struct {
	info     models.PeerInfo
	addrs    []ma.Multiaddr
	lastSeen time.Time
	// greeting is set while a hello is in flight, so the repeated
	// HandlePeerFound calls that mDNS produces do not stack up handshakes.
	greeting bool
	// probing is set while a disconnect is being confirmed, for the same reason.
	probing bool
	// announced is set once peer:found has been emitted, which is what makes
	// removal idempotent — peer:lost only fires for a peer the UI knows about.
	announced bool
}

// Node is a running discovery + share endpoint.
type Node struct {
	wails context.Context

	ctx    context.Context
	cancel context.CancelFunc

	host host.Host
	mdns mdns.Service

	localName string

	// pinHash is read on every inbound offer and written whenever settings
	// change, so it is an atomic rather than sitting under mu.
	pinHash atomic.Value // string

	mu    sync.Mutex
	peers map[peer.ID]*peerRec

	// pending maps a transfer ID to the channel its blocked handler waits on.
	pending sync.Map // string -> chan bool

	// onPayload applies a received payload and returns a human summary.
	onPayload func(models.SharePayload) string

	started bool
}

// New creates a Node. Nothing is opened until Start.
func New(onPayload func(models.SharePayload) string) *Node {
	n := &Node{
		localName: LocalName(),
		peers:     make(map[peer.ID]*peerRec),
		onPayload: onPayload,
	}
	n.pinHash.Store("")
	return n
}

// SetPIN updates the PIN required of inbound offers. Safe to call at any time;
// takes effect on the next offer without a restart.
func (n *Node) SetPIN(pin string) { n.pinHash.Store(HashPIN(pin)) }

// requiredPIN returns the current PIN hash, "" when none is set.
func (n *Node) requiredPIN() string {
	h, _ := n.pinHash.Load().(string)
	return h
}

// Start brings up the libp2p host, registers the stream handlers, and begins
// advertising and browsing. Calling Start on a running Node is a no-op, so the
// Discovery view can mount more than once without leaking hosts.
//
// wailsCtx is taken here rather than in New because the Wails runtime context
// does not exist until the app has started, whereas the Node is constructed
// alongside the other stores.
func (n *Node) Start(wailsCtx context.Context) error {
	n.mu.Lock()
	if n.started {
		n.mu.Unlock()
		return nil
	}
	n.started = true
	n.wails = wailsCtx
	n.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	n.ctx, n.cancel = ctx, cancel

	h, err := libp2p.New(
		libp2p.ListenAddrStrings(
			"/ip4/0.0.0.0/udp/0/quic-v1",
			"/ip4/0.0.0.0/tcp/0",
		),
	)
	if err != nil {
		n.teardown()
		return fmt.Errorf("libp2p host: %w", err)
	}
	n.host = h

	h.SetStreamHandler(HelloProto, n.handleHello)
	h.SetStreamHandler(ShareProto, n.handleShare)

	h.Network().Notify(&network.NotifyBundle{
		DisconnectedF: func(_ network.Network, c network.Conn) {
			n.onDisconnected(c.RemotePeer())
		},
	})

	svc := mdns.NewMdnsService(h, ServiceTag, n)
	if err := svc.Start(); err != nil {
		n.teardown()
		return fmt.Errorf("mdns: %w", err)
	}
	n.mdns = svc

	go n.sweepLoop()
	return nil
}

// Stop closes everything and forgets all peers. The frontend clears its own
// list on unmount, so no peer:lost storm is emitted here.
func (n *Node) Stop() {
	n.mu.Lock()
	if !n.started {
		n.mu.Unlock()
		return
	}
	n.started = false
	n.mu.Unlock()

	n.teardown()
}

func (n *Node) teardown() {
	if n.cancel != nil {
		n.cancel()
	}
	if n.mdns != nil {
		_ = n.mdns.Close()
		n.mdns = nil
	}
	if n.host != nil {
		_ = n.host.Close()
		n.host = nil
	}

	n.mu.Lock()
	n.peers = make(map[peer.ID]*peerRec)
	n.mu.Unlock()
}

// Peers returns the currently known peers. Used to seed a frontend that mounts
// after discovery has already found somebody.
func (n *Node) Peers() []models.PeerInfo {
	n.mu.Lock()
	defer n.mu.Unlock()

	out := make([]models.PeerInfo, 0, len(n.peers))
	for _, rec := range n.peers {
		if rec.announced {
			out = append(out, rec.info)
		}
	}
	return out
}

// --- discovery ---

// HandlePeerFound implements mdns.Notifee. It is called repeatedly for a live
// peer (that is what keeps lastSeen fresh) and concurrently across peers, so it
// must be cheap and idempotent for an already-known peer.
func (n *Node) HandlePeerFound(ai peer.AddrInfo) {
	if n.host == nil || ai.ID == n.host.ID() {
		return
	}

	n.mu.Lock()
	rec, known := n.peers[ai.ID]
	if !known {
		rec = &peerRec{}
		n.peers[ai.ID] = rec
	}
	rec.lastSeen = time.Now()
	if len(ai.Addrs) > 0 {
		rec.addrs = ai.Addrs
	}
	// Already visible, or a handshake is already running — nothing to do. This
	// is the common path: mDNS re-announces every peer roughly once a minute.
	if rec.announced || rec.greeting {
		n.mu.Unlock()
		return
	}
	rec.greeting = true
	n.mu.Unlock()

	go n.greet(ai)
}

// greet connects to a newly seen peer, asks who it is, and announces it.
func (n *Node) greet(ai peer.AddrInfo) {
	info, err := n.fetchHello(ai)

	n.mu.Lock()
	rec, ok := n.peers[ai.ID]
	if !ok {
		// Swept or torn down while we were dialling.
		n.mu.Unlock()
		return
	}
	rec.greeting = false
	if err != nil {
		// Leave the record in place: mDNS will re-announce and we will retry.
		// If the peer is genuinely gone, the TTL sweep collects it.
		n.mu.Unlock()
		return
	}
	rec.info = info
	rec.announced = true
	n.mu.Unlock()

	if h := n.host; h != nil {
		h.ConnManager().Protect(ai.ID, connTag)
	}
	n.emit(EventPeerFound, info)
}

// fetchHello dials the peer and reads its self-description.
func (n *Node) fetchHello(ai peer.AddrInfo) (models.PeerInfo, error) {
	h := n.host
	if h == nil {
		return models.PeerInfo{}, fmt.Errorf("host closed")
	}

	ctx, cancel := context.WithTimeout(n.ctx, helloTimeout)
	defer cancel()

	if err := h.Connect(ctx, ai); err != nil {
		return models.PeerInfo{}, fmt.Errorf("connect: %w", err)
	}

	s, err := h.NewStream(ctx, ai.ID, HelloProto)
	if err != nil {
		return models.PeerInfo{}, fmt.Errorf("hello stream: %w", err)
	}
	defer func() { _ = s.Close() }()

	// The peer writes and closes; a bad actor cannot make us read forever.
	raw, err := io.ReadAll(io.LimitReader(s, 4096))
	if err != nil {
		return models.PeerInfo{}, fmt.Errorf("hello read: %w", err)
	}

	var hi hello
	if err := json.Unmarshal(raw, &hi); err != nil {
		return models.PeerInfo{}, fmt.Errorf("hello decode: %w", err)
	}

	id := ai.ID.String()
	return models.PeerInfo{
		ID:          id,
		Name:        NormalizeName(hi.Name, id),
		PINRequired: hi.PINRequired,
	}, nil
}

// handleHello serves our own metadata to a peer that just discovered us.
func (n *Node) handleHello(s network.Stream) {
	defer func() { _ = s.Close() }()

	_ = s.SetWriteDeadline(time.Now().Add(helloTimeout))
	_ = json.NewEncoder(s).Encode(hello{
		Name:        n.localName,
		PINRequired: n.requiredPIN() != "",
	})
}

// --- peer removal ---

// onDisconnected reacts to a lost connection. A disconnect is a hint, not a
// verdict: the OS tears down sockets on sleep and Wi-Fi roams, and evicting a
// live peer would make the map jump. So we wait a beat and re-dial — a peer
// that has genuinely quit fails that dial.
func (n *Node) onDisconnected(id peer.ID) {
	n.mu.Lock()
	rec, ok := n.peers[id]
	if !ok || !rec.announced || rec.probing {
		n.mu.Unlock()
		return
	}
	rec.probing = true
	addrs := rec.addrs
	n.mu.Unlock()

	go n.probe(id, addrs)
}

func (n *Node) probe(id peer.ID, addrs []ma.Multiaddr) {
	select {
	case <-time.After(probeDelay):
	case <-n.ctx.Done():
		return
	}

	alive := false
	if h := n.host; h != nil {
		// Still connected — the disconnect was one of several transports, or it
		// has already been re-established. No dial needed.
		if h.Network().Connectedness(id) == network.Connected {
			alive = true
		} else {
			ctx, cancel := context.WithTimeout(n.ctx, probeTimeout)
			alive = h.Connect(ctx, peer.AddrInfo{ID: id, Addrs: addrs}) == nil
			cancel()
		}
	}

	n.mu.Lock()
	rec, ok := n.peers[id]
	if ok {
		rec.probing = false
		if alive {
			rec.lastSeen = time.Now()
		}
	}
	n.mu.Unlock()

	if !alive {
		n.forget(id)
	}
}

// sweepLoop reaps peers that stopped being announced. This is the backstop for
// a peer we never connected to, or one that disappeared without a disconnect.
func (n *Node) sweepLoop() {
	t := time.NewTicker(sweepInterval)
	defer t.Stop()

	for {
		select {
		case <-n.ctx.Done():
			return
		case <-t.C:
			n.sweep(time.Now())
		}
	}
}

// sweep drops peers unseen for longer than PeerTTL. Split from the loop so it
// can be driven directly by a test with a chosen clock.
func (n *Node) sweep(now time.Time) {
	n.mu.Lock()
	var expired []peer.ID
	for id, rec := range n.peers {
		if rec.greeting || rec.probing {
			continue
		}
		if now.Sub(rec.lastSeen) > PeerTTL {
			expired = append(expired, id)
		}
	}
	n.mu.Unlock()

	for _, id := range expired {
		n.forget(id)
	}
}

// forget removes a peer and emits peer:lost exactly once. The delete-under-lock
// return value is what makes it once-only: the disconnect probe and the sweep
// can both land on the same peer.
func (n *Node) forget(id peer.ID) {
	n.mu.Lock()
	rec, ok := n.peers[id]
	if !ok {
		n.mu.Unlock()
		return
	}
	delete(n.peers, id)
	announced := rec.announced
	n.mu.Unlock()

	if h := n.host; h != nil {
		h.ConnManager().Unprotect(id, connTag)
	}
	if announced {
		n.emit(EventPeerLost, map[string]string{"id": id.String()})
	}
}

// emit pushes an event to the frontend, tolerating a nil Wails context so the
// package can be exercised in tests without a running app.
//
// The context is read under the lock because Start writes it, and events are
// emitted from the mDNS, probe and sweep goroutines.
func (n *Node) emit(name string, data any) {
	n.mu.Lock()
	ctx := n.wails
	n.mu.Unlock()

	if ctx == nil {
		return
	}
	wailsRuntime.EventsEmit(ctx, name, data)
}
