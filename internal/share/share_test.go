package share

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"

	"yv/internal/models"
)

func TestHashPIN(t *testing.T) {
	tests := []struct {
		name string
		pin  string
		want string
	}{
		{"empty is the no-PIN sentinel", "", ""},
		{"whitespace only is also empty", "   ", ""},
		{"surrounding space is trimmed", " 1234 ", HashPIN("1234")},
		// A pinned digest, so a change of algorithm shows up here rather than by
		// silently invalidating every PIN a user has already set.
		{"known digest", "482910", "41d59ff0ac9815d60d3565149806eb6415348b7aa45a04ac6b2ba7eb8cb879ae"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := HashPIN(tc.pin); got != tc.want {
				t.Errorf("HashPIN(%q) = %q, want %q", tc.pin, got, tc.want)
			}
		})
	}
}

func TestHashPINDistinguishes(t *testing.T) {
	if HashPIN("1234") == HashPIN("1235") {
		t.Fatal("different PINs hashed to the same value")
	}
	// The empty-PIN sentinel must never collide with a real PIN's hash.
	if HashPIN("") == HashPIN("0") {
		t.Fatal("empty sentinel collided with a real PIN")
	}
}

func TestPINMatches(t *testing.T) {
	stored := HashPIN("482910")

	tests := []struct {
		name    string
		want    string
		offered string
		ok      bool
	}{
		{"no PIN configured accepts anything", "", "whatever", true},
		{"no PIN configured accepts empty", "", "", true},
		{"correct PIN", stored, "482910", true},
		{"correct PIN with spaces", stored, " 482910 ", true},
		{"wrong PIN", stored, "482911", false},
		{"empty offer against a set PIN", stored, "", false},
		{"whitespace offer against a set PIN", stored, "  ", false},
		{"a hash offered as the PIN does not pass", stored, stored, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := PINMatches(tc.want, tc.offered); got != tc.ok {
				t.Errorf("PINMatches(%q, %q) = %v, want %v", tc.want, tc.offered, got, tc.ok)
			}
		})
	}
}

func TestNormalizeName(t *testing.T) {
	const id = "12D3KooWABCDEFGHIJKLMNOPqrstuvwxyz123456"

	tests := []struct {
		name     string
		hostname string
		peerID   string
		want     string
	}{
		{"plain hostname", "Rexy", id, "Rexy"},
		{"mDNS .local suffix stripped", "Rexy.local", id, "Rexy"},
		{"trailing dot stripped", "Rexy.local.", id, "Rexy"},
		{"surrounding space trimmed", "  Rexy.local  ", id, "Rexy"},
		{"inner dots kept", "build.box", id, "build.box"},
		{"empty falls back to peer ID", "", id, "device 123456"},
		{"whitespace falls back to peer ID", "   ", id, "device 123456"},
		{"empty hostname and empty ID", "", "", "unknown device"},
		{"short peer ID used whole", "", "abc", "abc"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeName(tc.hostname, tc.peerID); got != tc.want {
				t.Errorf("NormalizeName(%q, %q) = %q, want %q", tc.hostname, tc.peerID, got, tc.want)
			}
		})
	}
}

// A device seen as "Rexy.local" over mDNS and "Rexy" elsewhere must resolve to
// one name, or it would draw as two different dinosaurs.
func TestNormalizeNameIsStableAcrossForms(t *testing.T) {
	const id = "12D3KooWtail99"
	forms := []string{"Rexy", "Rexy.local", "Rexy.local.", " Rexy.local "}

	first := NormalizeName(forms[0], id)
	for _, f := range forms[1:] {
		if got := NormalizeName(f, id); got != first {
			t.Errorf("NormalizeName(%q) = %q, want %q", f, got, first)
		}
	}
}

func TestReadPayloadRoundTrip(t *testing.T) {
	want := models.SharePayload{
		Scope: "project",
		Projects: []models.Project{{
			ID:         "p1",
			Name:       "POS",
			WorkingDir: "/tmp/pos",
			Commands: []models.CommandConfig{
				{ID: "c1", Label: "Build", Command: "make build", Group: "Android"},
			},
		}},
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if err := json.NewEncoder(gz).Encode(want); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	got, err := readPayload(&buf)
	if err != nil {
		t.Fatalf("readPayload: %v", err)
	}
	if got.Scope != want.Scope || len(got.Projects) != 1 {
		t.Fatalf("readPayload = %+v, want scope %q with 1 project", got, want.Scope)
	}
	if got.Projects[0].Name != "POS" || len(got.Projects[0].Commands) != 1 {
		t.Errorf("project did not survive the round trip: %+v", got.Projects[0])
	}
	if got.Projects[0].Commands[0].Command != "make build" {
		t.Errorf("command text lost: %q", got.Projects[0].Commands[0].Command)
	}
}

// gzip is worth the two lines it costs only if it actually shrinks the payload.
func TestPayloadCompresses(t *testing.T) {
	projects := make([]models.Project, 0, 20)
	for i := 0; i < 20; i++ {
		projects = append(projects, models.Project{
			ID:         "project-id-" + strings.Repeat("x", 8),
			Name:       "Service",
			WorkingDir: "/Users/someone/code/service",
			Groups:     []string{"Android", "iOS"},
			Commands: []models.CommandConfig{
				{ID: "cmd-1", Label: "Clean & Build", Command: "./gradlew clean && ./gradlew assembleRelease", Group: "Android"},
				{ID: "cmd-2", Label: "Install", Command: "adb install -r app/build/outputs/apk/release/app-release.apk", Group: "Android"},
			},
		})
	}
	payload := models.SharePayload{Scope: "app", Projects: projects}

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if err := json.NewEncoder(gz).Encode(payload); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	ratio := float64(buf.Len()) / float64(len(raw))
	if ratio > 0.5 {
		t.Errorf("gzip only got config to %.0f%% of raw JSON (%d → %d bytes); "+
			"if this is really the best case, compression is not paying for itself",
			ratio*100, len(raw), buf.Len())
	}
}

func TestReadPayloadRejectsGarbage(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{"not gzip at all", []byte(`{"scope":"app"}`)},
		{"empty", nil},
		{"truncated gzip header", []byte{0x1f, 0x8b}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := readPayload(bytes.NewReader(tc.body)); err == nil {
				t.Error("readPayload accepted garbage, want error")
			}
		})
	}
}

// gzip of valid-but-non-payload JSON should fail at the decode step, not panic.
func TestReadPayloadRejectsWrongShape(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	_, _ = gz.Write([]byte(`"a bare string"`))
	_ = gz.Close()

	if _, err := readPayload(&buf); err == nil {
		t.Error("readPayload accepted a bare JSON string, want error")
	}
}

func TestNewTransferIDNamespacesByPeer(t *testing.T) {
	a, err := peer.Decode("12D3KooWGRUvHZbRfBPzTZTQwCzHkAqhWkQiUUCU5Xw3rxHfTvSy")
	if err != nil {
		t.Fatalf("decode a: %v", err)
	}
	b, err := peer.Decode("12D3KooWJvyP3VJYymTqG7eH4PM5rN4T2agk5cdNCfNymAqwqcuZ")
	if err != nil {
		t.Fatalf("decode b: %v", err)
	}

	// Two peers claiming the same transfer ID must not collide, or one could
	// answer — or cancel — the other's in-flight offer.
	if newTransferID(a, "1") == newTransferID(b, "1") {
		t.Fatal("distinct peers produced the same transfer ID")
	}
	if !strings.HasPrefix(newTransferID(a, "1"), a.String()) {
		t.Error("transfer ID is not namespaced by the peer ID")
	}
	// An over-long claim is truncated rather than trusted wholesale.
	long := strings.Repeat("z", 500)
	if got := newTransferID(a, long); len(got) > len(a.String())+1+64 {
		t.Errorf("transfer ID not truncated: length %d", len(got))
	}
	// An empty claim still yields a usable ID.
	if got := newTransferID(a, ""); got == a.String()+":" {
		t.Error("empty claim produced an empty suffix")
	}
}

func TestSweepExpiresOnlyStalePeers(t *testing.T) {
	now := time.Now()

	fresh, err := peer.Decode("12D3KooWGRUvHZbRfBPzTZTQwCzHkAqhWkQiUUCU5Xw3rxHfTvSy")
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	stale, err := peer.Decode("12D3KooWJvyP3VJYymTqG7eH4PM5rN4T2agk5cdNCfNymAqwqcuZ")
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	n := New(nil)
	n.ctx, n.cancel = context.WithCancel(context.Background())
	defer n.cancel()

	n.peers[fresh] = &peerRec{announced: true, lastSeen: now.Add(-PeerTTL + time.Minute)}
	n.peers[stale] = &peerRec{announced: true, lastSeen: now.Add(-PeerTTL - time.Second)}

	n.sweep(now)

	if _, ok := n.peers[fresh]; !ok {
		t.Error("a peer seen within PeerTTL was swept")
	}
	if _, ok := n.peers[stale]; ok {
		t.Error("a peer unseen for longer than PeerTTL survived the sweep")
	}
}

// A peer mid-handshake or mid-probe has no meaningful lastSeen yet; sweeping it
// would cancel the very work that is about to confirm it.
func TestSweepSkipsBusyPeers(t *testing.T) {
	now := time.Now()
	old := now.Add(-PeerTTL - time.Hour)

	greeting, _ := peer.Decode("12D3KooWGRUvHZbRfBPzTZTQwCzHkAqhWkQiUUCU5Xw3rxHfTvSy")
	probing, _ := peer.Decode("12D3KooWJvyP3VJYymTqG7eH4PM5rN4T2agk5cdNCfNymAqwqcuZ")

	n := New(nil)
	n.ctx, n.cancel = context.WithCancel(context.Background())
	defer n.cancel()

	n.peers[greeting] = &peerRec{greeting: true, lastSeen: old}
	n.peers[probing] = &peerRec{announced: true, probing: true, lastSeen: old}

	n.sweep(now)

	if len(n.peers) != 2 {
		t.Errorf("sweep reaped a busy peer: %d of 2 remain", len(n.peers))
	}
}

func TestForgetIsIdempotent(t *testing.T) {
	id, _ := peer.Decode("12D3KooWGRUvHZbRfBPzTZTQwCzHkAqhWkQiUUCU5Xw3rxHfTvSy")

	n := New(nil)
	n.ctx, n.cancel = context.WithCancel(context.Background())
	defer n.cancel()

	n.peers[id] = &peerRec{announced: true, lastSeen: time.Now()}

	// Both the disconnect probe and the sweep can land on the same peer, so the
	// second call must be a no-op rather than a second peer:lost.
	n.forget(id)
	n.forget(id)

	if len(n.peers) != 0 {
		t.Errorf("peer survived forget: %d remain", len(n.peers))
	}
}

func TestRespondReportsUnknownTransfer(t *testing.T) {
	n := New(nil)

	if n.Respond("no-such-transfer", true) {
		t.Error("Respond claimed success for a transfer that was not waiting")
	}

	ch := make(chan bool, 1)
	n.pending.Store("t1", ch)

	if !n.Respond("t1", true) {
		t.Fatal("Respond failed for a waiting transfer")
	}
	if got := <-ch; !got {
		t.Error("Respond delivered the wrong decision")
	}
	// The entry is consumed, so a double-click cannot answer twice.
	if n.Respond("t1", false) {
		t.Error("Respond answered the same transfer twice")
	}
}

func TestPeersOnlyReturnsAnnounced(t *testing.T) {
	announced, _ := peer.Decode("12D3KooWGRUvHZbRfBPzTZTQwCzHkAqhWkQiUUCU5Xw3rxHfTvSy")
	pendingPeer, _ := peer.Decode("12D3KooWJvyP3VJYymTqG7eH4PM5rN4T2agk5cdNCfNymAqwqcuZ")

	n := New(nil)
	n.peers[announced] = &peerRec{announced: true, info: models.PeerInfo{ID: "a", Name: "Rexy"}}
	n.peers[pendingPeer] = &peerRec{greeting: true}

	got := n.Peers()
	if len(got) != 1 || got[0].Name != "Rexy" {
		t.Errorf("Peers() = %+v, want only the announced peer", got)
	}
}
