package share

import (
	"testing"
	"time"

	"yv/internal/models"
)

// TestMDNSDiscoversPeer is the one test that exercises real multicast: two nodes
// on the loopback network must find each other, complete the hello handshake, and
// end up with each other's name and PIN flag.
//
// Skipped with -short because it depends on the machine actually allowing mDNS —
// a sandbox or a locked-down firewall will fail it for reasons that have nothing
// to do with this code.
func TestMDNSDiscoversPeer(t *testing.T) {
	if testing.Short() {
		t.Skip("needs multicast; run without -short")
	}

	a := New(nil)
	a.localName = "Rexy"
	if err := a.Start(nil); err != nil {
		t.Fatalf("start a: %v", err)
	}
	defer a.Stop()

	b := New(nil)
	b.localName = "Bronte"
	b.SetPIN("482910")
	if err := b.Start(nil); err != nil {
		t.Fatalf("start b: %v", err)
	}
	defer b.Stop()

	// zeroconf's first query goes out immediately and then backs off, so a peer
	// on the same host normally lands within a couple of seconds. The generous
	// ceiling is for a loaded machine, not an expected wait.
	found := waitForPeer(a, b.host.ID().String(), 30*time.Second)
	if found == nil {
		t.Fatal("a never discovered b over mDNS")
	}

	if found.Name != "Bronte" {
		t.Errorf("Name = %q, want %q — the hello handshake did not resolve the hostname", found.Name, "Bronte")
	}
	if !found.PINRequired {
		t.Error("PINRequired = false, want true — b has a PIN set")
	}

	// Discovery is symmetric: both sides browse, so b should see a as well.
	if back := waitForPeer(b, a.host.ID().String(), 30*time.Second); back == nil {
		t.Error("b never discovered a")
	} else if back.PINRequired {
		t.Error("a was reported as needing a PIN, but none is set on it")
	}
}

// A node must never list itself; its own announcement is on the same multicast
// group as everyone else's.
func TestMDNSIgnoresSelf(t *testing.T) {
	if testing.Short() {
		t.Skip("needs multicast; run without -short")
	}

	n := New(nil)
	n.localName = "Solo"
	if err := n.Start(nil); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer n.Stop()

	self := n.host.ID().String()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		for _, p := range n.Peers() {
			if p.ID == self {
				t.Fatal("a node discovered itself")
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Start is called on every mount of the Discovery view, so it has to be safe to
// call repeatedly without leaking a second host or a second mDNS service.
func TestStartIsIdempotent(t *testing.T) {
	n := New(nil)
	if err := n.Start(nil); err != nil {
		t.Fatalf("first start: %v", err)
	}
	defer n.Stop()

	first := n.host
	if err := n.Start(nil); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if n.host != first {
		t.Error("a second Start replaced the host, leaking the first")
	}
}

// Stop must leave the node restartable, since the app can stop discovery on
// shutdown and a test or a later session can bring it back.
func TestStopThenStart(t *testing.T) {
	n := New(nil)
	if err := n.Start(nil); err != nil {
		t.Fatalf("start: %v", err)
	}
	n.Stop()

	if got := n.Peers(); len(got) != 0 {
		t.Errorf("Peers() = %v after Stop, want empty", got)
	}

	if err := n.Start(nil); err != nil {
		t.Fatalf("restart: %v", err)
	}
	n.Stop()
}

func waitForPeer(n *Node, id string, within time.Duration) *models.PeerInfo {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		for _, p := range n.Peers() {
			if p.ID == id {
				found := p
				return &found
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil
}
