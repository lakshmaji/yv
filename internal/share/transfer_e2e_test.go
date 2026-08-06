package share

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"

	"yv/internal/models"
)

// newTestNode builds a Node on a real in-process libp2p host, wired the same way
// Start does but without mDNS — discovery is not what these tests are about, and
// multicast in CI is unreliable.
func newTestNode(t *testing.T, name string, onPayload func(models.SharePayload) string) *Node {
	t.Helper()

	h, err := libp2p.New(libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatalf("libp2p host: %v", err)
	}

	n := New(onPayload)
	n.localName = name
	n.host = h
	n.started = true
	n.ctx, n.cancel = context.WithCancel(context.Background())

	h.SetStreamHandler(HelloProto, n.handleHello)
	h.SetStreamHandler(ShareProto, n.handleShare)

	t.Cleanup(func() {
		n.cancel()
		_ = h.Close()
	})
	return n
}

// connect dials b from a so the two can open streams.
func connect(t *testing.T, a, b *Node) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := a.host.Connect(ctx, peer.AddrInfo{
		ID:    b.host.ID(),
		Addrs: b.host.Addrs(),
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
}

// autoRespond answers the next incoming offer. Returns a channel carrying the
// offer that was seen, so a test can assert on what the receiver was shown.
func autoRespond(t *testing.T, n *Node, accept bool) <-chan models.ShareOffer {
	t.Helper()
	seen := make(chan models.ShareOffer, 1)

	go func() {
		deadline := time.After(10 * time.Second)
		for {
			select {
			case <-deadline:
				return
			case <-time.After(10 * time.Millisecond):
			}

			var found string
			n.pending.Range(func(k, _ any) bool {
				found, _ = k.(string)
				return false
			})
			if found == "" {
				continue
			}
			seen <- models.ShareOffer{TransferID: found}
			n.Respond(found, accept)
			return
		}
	}()
	return seen
}

func samplePayload() models.SharePayload {
	return models.SharePayload{
		Scope: "project",
		Projects: []models.Project{{
			ID:         "p-1",
			Name:       "POS",
			WorkingDir: "/tmp/pos",
			Commands: []models.CommandConfig{
				{ID: "c-1", Label: "Build", Command: "./gradlew assembleRelease", Group: "Android"},
			},
		}},
	}
}

func TestSendAndReceiveAccepted(t *testing.T) {
	got := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		got <- p
		return "Imported 1 project(s)"
	})
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	autoRespond(t, receiver, true)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	offer := models.ShareOffer{TransferID: "1", Scope: "project", ProjectName: "POS", ProjectCount: 1}
	if err := sender.Send(ctx, receiver.host.ID().String(), offer, samplePayload()); err != nil {
		t.Fatalf("Send: %v", err)
	}

	select {
	case p := <-got:
		if len(p.Projects) != 1 || p.Projects[0].Name != "POS" {
			t.Fatalf("payload arrived wrong: %+v", p)
		}
		if p.Projects[0].Commands[0].Command != "./gradlew assembleRelease" {
			t.Errorf("command text lost in transit: %q", p.Projects[0].Commands[0].Command)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("payload never reached the receiver")
	}
}

func TestSendDeclined(t *testing.T) {
	applied := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		applied <- p
		return "should not happen"
	})
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	autoRespond(t, receiver, false)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	err := sender.Send(ctx, receiver.host.ID().String(), models.ShareOffer{TransferID: "1", Scope: "app"}, samplePayload())
	if !errors.Is(err, ErrDeclined) {
		t.Fatalf("Send err = %v, want ErrDeclined", err)
	}

	// A decline must not write anything.
	select {
	case p := <-applied:
		t.Fatalf("payload was applied despite a decline: %+v", p)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestSendWrongPIN(t *testing.T) {
	applied := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		applied <- p
		return "should not happen"
	})
	receiver.SetPIN("482910")

	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	offer := models.ShareOffer{TransferID: "1", Scope: "app", PIN: "000000"}
	err := sender.Send(ctx, receiver.host.ID().String(), offer, samplePayload())
	if !errors.Is(err, ErrBadPIN) {
		t.Fatalf("Send err = %v, want ErrBadPIN", err)
	}

	// A wrong PIN must be rejected before the user is ever prompted — otherwise
	// the PIN would be no barrier at all, just an extra field.
	if _, waiting := anyPending(receiver); waiting {
		t.Error("a wrong PIN still raised a prompt on the receiver")
	}

	select {
	case p := <-applied:
		t.Fatalf("payload was applied despite a wrong PIN: %+v", p)
	case <-time.After(500 * time.Millisecond):
	}
}

func TestSendCorrectPIN(t *testing.T) {
	got := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		got <- p
		return "Imported 1 project(s)"
	})
	receiver.SetPIN("482910")

	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	autoRespond(t, receiver, true)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	offer := models.ShareOffer{TransferID: "1", Scope: "app", PIN: "482910"}
	if err := sender.Send(ctx, receiver.host.ID().String(), offer, samplePayload()); err != nil {
		t.Fatalf("Send with the correct PIN: %v", err)
	}

	select {
	case <-got:
	case <-time.After(10 * time.Second):
		t.Fatal("payload never arrived despite the correct PIN")
	}
}

// A PIN set after the node is running must apply to the next offer, because the
// Settings modal changes it without restarting discovery.
func TestSetPINTakesEffectImmediately(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	receiver.SetPIN("111111")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	err := sender.Send(ctx, receiver.host.ID().String(),
		models.ShareOffer{TransferID: "1", Scope: "app"}, samplePayload())
	if !errors.Is(err, ErrBadPIN) {
		t.Fatalf("Send err = %v, want ErrBadPIN after SetPIN", err)
	}

	// And clearing it must reopen the door.
	receiver.SetPIN("")
	autoRespond(t, receiver, true)

	if err := sender.Send(ctx, receiver.host.ID().String(),
		models.ShareOffer{TransferID: "2", Scope: "app"}, samplePayload()); err != nil {
		t.Fatalf("Send after clearing the PIN: %v", err)
	}
}

// The receiver shows the name it resolved for the peer, not whatever the sender
// puts in the header — a peer should not be able to label itself as someone else.
func TestOfferNameIsNotTakenFromTheHeader(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	// Teach the receiver who the sender really is, as hello would.
	receiver.mu.Lock()
	receiver.peers[sender.host.ID()] = &peerRec{
		announced: true,
		lastSeen:  time.Now(),
		info:      models.PeerInfo{ID: sender.host.ID().String(), Name: "Rexy"},
	}
	receiver.mu.Unlock()

	if got := receiver.displayName(sender.host.ID(), "Totally Not Rexy"); got != "Rexy" {
		t.Errorf("displayName = %q, want the resolved name %q", got, "Rexy")
	}
}

func TestSendToUnknownPeerIDFails(t *testing.T) {
	sender := newTestNode(t, "Rexy", nil)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := sender.Send(ctx, "not-a-peer-id", models.ShareOffer{}, samplePayload()); err == nil {
		t.Error("Send accepted a malformed peer ID")
	}
}

func TestFetchHelloReportsNameAndPIN(t *testing.T) {
	tests := []struct {
		name        string
		pin         string
		wantPINReqd bool
	}{
		{"no PIN configured", "", false},
		{"PIN configured", "482910", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			remote := newTestNode(t, "Bronte.local", nil)
			remote.SetPIN(tc.pin)

			local := newTestNode(t, "Rexy", nil)
			connect(t, local, remote)

			info, err := local.fetchHello(peer.AddrInfo{
				ID:    remote.host.ID(),
				Addrs: remote.host.Addrs(),
			})
			if err != nil {
				t.Fatalf("fetchHello: %v", err)
			}
			// ".local" must be stripped, or the same machine would draw as two
			// different dinosaurs depending on how it was seen.
			if info.Name != "Bronte" {
				t.Errorf("Name = %q, want %q", info.Name, "Bronte")
			}
			if info.PINRequired != tc.wantPINReqd {
				t.Errorf("PINRequired = %v, want %v", info.PINRequired, tc.wantPINReqd)
			}
			if info.ID != remote.host.ID().String() {
				t.Errorf("ID = %q, want %q", info.ID, remote.host.ID().String())
			}
		})
	}
}

// A sender that vanishes after the offer must not leave the receiver's prompt
// wired to a dead stream, nor apply a partial payload.
func TestReceiverSurvivesSenderDisappearing(t *testing.T) {
	applied := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		applied <- p
		return "should not happen"
	})
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	// Open the stream, write the offer, then drop the connection before the
	// payload — the shape of a laptop being killed mid-transfer.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	s, err := sender.host.NewStream(ctx, receiver.host.ID(), ShareProto)
	if err != nil {
		t.Fatalf("NewStream: %v", err)
	}
	if err := writeOffer(s, models.ShareOffer{TransferID: "1", Scope: "app"}); err != nil {
		t.Fatalf("write offer: %v", err)
	}

	id, waiting := waitForPending(receiver, 5*time.Second)
	if !waiting {
		t.Fatal("receiver never raised a prompt")
	}

	_ = s.Reset()
	_ = sender.host.Network().ClosePeer(receiver.host.ID())

	// Accepting after the sender is gone must fail cleanly rather than hang or
	// import half a payload.
	receiver.Respond(id, true)

	select {
	case p := <-applied:
		t.Fatalf("a payload was applied from a dead stream: %+v", p)
	case <-time.After(2 * time.Second):
	}
}

// --- small test helpers ---

func writeOffer(s network.Stream, offer models.ShareOffer) error {
	_ = s.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return encodeJSON(s, offer)
}

func anyPending(n *Node) (string, bool) {
	var id string
	n.pending.Range(func(k, _ any) bool {
		id, _ = k.(string)
		return false
	})
	return id, id != ""
}

func waitForPending(n *Node, within time.Duration) (string, bool) {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if id, ok := anyPending(n); ok {
			return id, true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return "", false
}

func encodeJSON(w io.Writer, v any) error {
	return json.NewEncoder(w).Encode(v)
}
