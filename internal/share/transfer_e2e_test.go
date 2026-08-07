package share

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
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

// letIn marks the sender as already connected on the receiver, which is what
// the code handshake does. Transfers are refused without it, so every test that
// sends something needs this — the alternative would be running the whole
// handshake in each one, which tests the same three lines over and over.
func letIn(t *testing.T, receiver, sender *Node) {
	t.Helper()
	receiver.conns.Open(sender.host.ID(), time.Now())
}

// answerConnect watches for an inbound connection request and types a code into
// it, standing in for the user at the receiving keyboard.
func answerConnect(t *testing.T, n *Node, code string) <-chan string {
	t.Helper()
	result := make(chan string, 1)

	go func() {
		deadline := time.After(10 * time.Second)
		for {
			select {
			case <-deadline:
				result <- "no request arrived"
				return
			case <-time.After(10 * time.Millisecond):
			}

			var id string
			n.connPending.Range(func(k, _ any) bool {
				id, _ = k.(string)
				return false
			})
			if id == "" {
				continue
			}
			matched, remaining, found := n.AnswerConnect(id, code)
			result <- fmt.Sprintf("matched=%v remaining=%d found=%v", matched, remaining, found)
			return
		}
	}()
	return result
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
	letIn(t, receiver, sender)

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
	letIn(t, receiver, sender)

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
	remote := newTestNode(t, "Bronte.local", nil)
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
	// Always true: there is no setting that opens this device up.
	if !info.PINRequired {
		t.Error("PINRequired = false, want true — every connection needs a code")
	}
	if info.ID != remote.host.ID().String() {
		t.Errorf("ID = %q, want %q", info.ID, remote.host.ID().String())
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
	letIn(t, receiver, sender)

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

// --- file transfer ---

func TestSendFiles(t *testing.T) {
	got := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		got <- p
		return "Saved 2 files"
	})
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)
	letIn(t, receiver, sender)

	autoRespond(t, receiver, true)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Binary, so this also proves the base64 round-trip is byte-exact rather
	// than merely surviving for text.
	binary := make([]byte, 4096)
	for i := range binary {
		binary[i] = byte(i % 251)
	}

	payload := models.SharePayload{
		Scope: ScopeFiles,
		Files: []models.SharedFile{
			{Name: "notes.txt", Size: 5, Data: []byte("hello")},
			{Name: "blob.bin", Size: int64(len(binary)), Data: binary},
		},
	}
	offer := models.ShareOffer{
		TransferID: "1",
		Scope:      ScopeFiles,
		FileNames:  []string{"notes.txt", "blob.bin"},
		TotalBytes: int64(5 + len(binary)),
	}

	if err := sender.Send(ctx, receiver.host.ID().String(), offer, payload); err != nil {
		t.Fatalf("Send: %v", err)
	}

	select {
	case p := <-got:
		if len(p.Files) != 2 {
			t.Fatalf("got %d files, want 2", len(p.Files))
		}
		if string(p.Files[0].Data) != "hello" {
			t.Errorf("text file arrived as %q", p.Files[0].Data)
		}
		if !bytes.Equal(p.Files[1].Data, binary) {
			t.Error("binary file did not survive the round trip")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("files never reached the receiver")
	}
}

// --- the connection handshake ---

// The happy path: the sender draws a code, the receiver's user types it, and
// the connection opens.
func TestConnectWithTheRightCode(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	code, err := GeneratePIN()
	if err != nil {
		t.Fatalf("GeneratePIN: %v", err)
	}
	answerConnect(t, receiver, code)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := sender.RequestConnect(ctx, receiver.host.ID().String(), code); err != nil {
		t.Fatalf("RequestConnect: %v", err)
	}
	if !receiver.conns.Connected(sender.host.ID(), time.Now()) {
		t.Error("the connection was accepted but not recorded")
	}
}

// Typed in lower case, which is what happens when someone reads a code down the
// phone. It must still work, or a correct answer would be indistinguishable
// from a wrong one.
func TestConnectCodeIsCaseInsensitive(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	code, _ := GeneratePIN()
	answerConnect(t, receiver, strings.ToLower(code))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := sender.RequestConnect(ctx, receiver.host.ID().String(), code); err != nil {
		t.Fatalf("RequestConnect with a lower-cased answer: %v", err)
	}
}

func TestConnectWithTheWrongCode(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	// Wrong every time, so the request runs out of attempts and is dropped.
	go func() {
		deadline := time.After(10 * time.Second)
		for {
			select {
			case <-deadline:
				return
			case <-time.After(10 * time.Millisecond):
			}
			var id string
			receiver.connPending.Range(func(k, _ any) bool {
				id, _ = k.(string)
				return false
			})
			if id == "" {
				continue
			}
			for i := 0; i < MaxCodeAttempts; i++ {
				receiver.AnswerConnect(id, "WRONGCOD")
			}
			return
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	code, _ := GeneratePIN()
	err := sender.RequestConnect(ctx, receiver.host.ID().String(), code)
	if !errors.Is(err, ErrDeclined) {
		t.Fatalf("RequestConnect err = %v, want ErrDeclined", err)
	}
	if receiver.conns.Connected(sender.host.ID(), time.Now()) {
		t.Error("a run of wrong codes still opened the connection")
	}
}

// The count is what the dialog shows, and it has to stop at zero rather than
// letting someone at the keyboard keep going.
func TestConnectAttemptsRunOut(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		code, _ := GeneratePIN()
		_ = sender.RequestConnect(ctx, receiver.host.ID().String(), code)
	}()

	var id string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && id == "" {
		receiver.connPending.Range(func(k, _ any) bool {
			id, _ = k.(string)
			return false
		})
		time.Sleep(10 * time.Millisecond)
	}
	if id == "" {
		t.Fatal("no connection request arrived")
	}

	for i := 1; i <= MaxCodeAttempts; i++ {
		matched, remaining, found := receiver.AnswerConnect(id, "NOPENOPE")
		if matched {
			t.Fatalf("attempt %d matched a wrong code", i)
		}
		if !found {
			t.Fatalf("attempt %d: request vanished early", i)
		}
		if want := MaxCodeAttempts - i; remaining != want {
			t.Errorf("attempt %d: remaining = %d, want %d", i, remaining, want)
		}
	}

	// Spent. A further answer — even the right one — must not get in.
	if _, _, found := receiver.AnswerConnect(id, "NOPENOPE"); found {
		if matched, _, _ := receiver.AnswerConnect(id, "NOPENOPE"); matched {
			t.Error("a spent request still accepted a code")
		}
	}
}

// The whole point of sending only the hash: the receiving device cannot show
// the code, so its user can only have been told it.
func TestConnectCodeNeverReachesTheReceiverInTheClear(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	code, _ := GeneratePIN()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = sender.RequestConnect(ctx, receiver.host.ID().String(), code)
	}()

	var req *connReq
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && req == nil {
		receiver.connPending.Range(func(_, v any) bool {
			req, _ = v.(*connReq)
			return false
		})
		time.Sleep(10 * time.Millisecond)
	}
	if req == nil {
		t.Fatal("no connection request arrived")
	}

	if strings.Contains(req.codeHash, code) || req.codeHash == code {
		t.Error("the plaintext code reached the receiver")
	}
	if req.codeHash != HashPIN(code) {
		t.Error("the receiver did not get a usable hash of the code")
	}
}

// A transfer from a device that never connected is refused outright — the
// connection step is where its owner decided to talk to them at all.
func TestSendWithoutConnectingIsRefused(t *testing.T) {
	applied := make(chan models.SharePayload, 1)

	receiver := newTestNode(t, "Bronte", func(p models.SharePayload) string {
		applied <- p
		return "should not happen"
	})
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	offer := models.ShareOffer{TransferID: "1", Scope: ScopeApp}
	err := sender.Send(ctx, receiver.host.ID().String(), offer, samplePayload())
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Send err = %v, want ErrNotConnected", err)
	}

	// And crucially, no prompt: an unconnected peer must not be able to put a
	// dialog on someone's screen just by offering.
	if _, waiting := anyPending(receiver); waiting {
		t.Error("an unconnected peer raised a transfer prompt")
	}
	select {
	case p := <-applied:
		t.Fatalf("payload applied without a connection: %+v", p)
	case <-time.After(500 * time.Millisecond):
	}
}

// Disconnecting closes the door again.
func TestDisconnectRefusesLaterTransfers(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)
	letIn(t, receiver, sender)

	receiver.DismissConnect(sender.host.ID().String())

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	err := sender.Send(ctx, receiver.host.ID().String(),
		models.ShareOffer{TransferID: "1", Scope: ScopeApp}, samplePayload())
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("Send err = %v, want ErrNotConnected after disconnect", err)
	}
}

// An unanswered prompt must not be reported as a refusal. Saying "they did not
// accept" while the other person has not touched anything is what sent this
// distinction into the protocol in the first place.
func TestNoAnswerIsNotADecline(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	// Nobody is at the receiving keyboard, so the prompt expires untouched.
	receiver.decisionWait = 300 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	code, _ := GeneratePIN()
	err := sender.RequestConnect(ctx, receiver.host.ID().String(), code)
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("RequestConnect err = %v, want ErrNoAnswer", err)
	}
	// The distinction is the point: an untouched prompt is not a refusal.
	if errors.Is(err, ErrDeclined) {
		t.Error("an unanswered request was reported as a decline")
	}
}

// A declined request is reported as exactly that.
func TestDeclineIsReportedAsADecline(t *testing.T) {
	receiver := newTestNode(t, "Bronte", func(models.SharePayload) string { return "ok" })
	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, receiver)

	go func() {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var id string
			receiver.connPending.Range(func(k, _ any) bool {
				id, _ = k.(string)
				return false
			})
			if id != "" {
				receiver.DeclineConnect(id)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	code, _ := GeneratePIN()
	err := sender.RequestConnect(ctx, receiver.host.ID().String(), code)
	if !errors.Is(err, ErrDeclined) {
		t.Fatalf("RequestConnect err = %v, want ErrDeclined", err)
	}
}

// A peer that does not speak this protocol version is named as such, rather
// than surfacing as a refusal nobody made.
func TestOldPeerIsReportedAsOutOfDate(t *testing.T) {
	// A node with no share handler at all stands in for a build that only
	// registered the previous protocol version.
	old := newTestNode(t, "Bronte", nil)
	old.host.RemoveStreamHandler(ShareProto)

	sender := newTestNode(t, "Rexy", nil)
	connect(t, sender, old)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	code, _ := GeneratePIN()
	err := sender.RequestConnect(ctx, old.host.ID().String(), code)
	if !errors.Is(err, ErrOldVersion) {
		t.Fatalf("RequestConnect err = %v, want ErrOldVersion", err)
	}

	// Same for a transfer, so neither path blames the user for a version skew.
	err = sender.Send(ctx, old.host.ID().String(),
		models.ShareOffer{TransferID: "1", Scope: ScopeApp}, samplePayload())
	if !errors.Is(err, ErrOldVersion) {
		t.Fatalf("Send err = %v, want ErrOldVersion", err)
	}
}

// The version in the protocol id is what makes the check above possible; a
// silent bump back to 1.0.0 would let an old peer misread a connection request
// as a transfer offer again.
func TestShareProtocolIsVersioned(t *testing.T) {
	if ShareProto == "/yv/share/1.0.0" {
		t.Error("ShareProto is back on 1.0.0, which an old build would answer wrongly")
	}
}
