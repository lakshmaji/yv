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

func TestSetLocalName(t *testing.T) {
	host := LocalName()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"a chosen name is announced", "Lakshmaji", "Lakshmaji"},
		{"padding is trimmed", "  Lakshmaji  ", "Lakshmaji"},
		// Not NormalizeName: that strips ".local" because a hostname carries it.
		// A person who types it meant it.
		{"a typed name keeps a dotted suffix", "Rexy.local", "Rexy.local"},
		{"empty falls back to the hostname", "", host},
		{"whitespace falls back too — a blank name is not a name", "   ", host},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := New(nil)
			n.SetLocalName(tt.in)
			if got := n.LocalName(); got != tt.want {
				t.Errorf("after SetLocalName(%q), LocalName() = %q, want %q", tt.in, got, tt.want)
			}
		})
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

	got, err := readPayload(&buf, maxPayload)
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
			if _, err := readPayload(bytes.NewReader(tc.body), maxPayload); err == nil {
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

	if _, err := readPayload(&buf, maxPayload); err == nil {
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

// The offer header is JSON on the wire, so a missing tag on a new field would
// show up as a receiver that cannot describe what it is being offered.
func TestShareOfferHeaderRoundTrips(t *testing.T) {
	want := models.ShareOffer{
		TransferID:   "t-1",
		FromName:     "Rexy",
		Scope:        ScopeProject,
		ProjectName:  "POS",
		ProjectCount: 2,
		FileNames:    []string{"notes.txt", "blob.bin"},
		TotalBytes:   4101,
		Kind:         models.OfferKindConnect,
		PIN:          "482910",
	}

	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got models.ShareOffer
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Scope != want.Scope || got.TotalBytes != want.TotalBytes || got.Kind != want.Kind {
		t.Errorf("header lost fields: %+v", got)
	}
	if len(got.FileNames) != 2 || got.FileNames[1] != "blob.bin" {
		t.Errorf("file names lost: %+v", got.FileNames)
	}
}

// --- generated connection codes ---

func TestGeneratePINShape(t *testing.T) {
	for i := 0; i < 200; i++ {
		code, err := GeneratePIN()
		if err != nil {
			t.Fatalf("GeneratePIN: %v", err)
		}
		if len(code) != PINLength {
			t.Fatalf("len(%q) = %d, want %d", code, len(code), PINLength)
		}
		for _, r := range code {
			if !strings.ContainsRune(pinAlphabet, r) {
				t.Fatalf("%q contains %q, which is not in the alphabet", code, r)
			}
		}
	}
}

// The homoglyphs are excluded on purpose: a code is transcribed by hand, and an
// O read as a 0 fails with no clue as to why.
func TestGeneratePINAvoidsAmbiguousCharacters(t *testing.T) {
	for _, bad := range []rune{'0', 'O', '1', 'I', 'L'} {
		if strings.ContainsRune(pinAlphabet, bad) {
			t.Errorf("alphabet contains the ambiguous character %q", bad)
		}
	}
}

func TestGeneratePINIsNotRepetitive(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 500; i++ {
		code, err := GeneratePIN()
		if err != nil {
			t.Fatalf("GeneratePIN: %v", err)
		}
		if seen[code] {
			t.Fatalf("GeneratePIN repeated %q within 500 draws", code)
		}
		seen[code] = true
	}
}

// Every position must be able to vary — a bug that fixed one character would
// still pass the shape and uniqueness checks above.
func TestGeneratePINVariesInEveryPosition(t *testing.T) {
	distinct := make([]map[byte]bool, PINLength)
	for i := range distinct {
		distinct[i] = make(map[byte]bool)
	}

	for i := 0; i < 400; i++ {
		code, _ := GeneratePIN()
		for pos := 0; pos < PINLength; pos++ {
			distinct[pos][code[pos]] = true
		}
	}
	for pos, set := range distinct {
		if len(set) < 10 {
			t.Errorf("position %d only ever took %d values", pos, len(set))
		}
	}
}

func TestNormalizePIN(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"ABCD2345", "ABCD2345"},
		{"abcd2345", "ABCD2345"},
		{"  AbCd2345  ", "ABCD2345"},
		{"", ""},
		{"   ", ""},
		// Digits are unaffected, which is why a PIN set by an older build still
		// matches after case folding was introduced.
		{"482910", "482910"},
	}

	for _, tc := range tests {
		if got := NormalizePIN(tc.in); got != tc.want {
			t.Errorf("NormalizePIN(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCodeMatches(t *testing.T) {
	tests := []struct {
		name    string
		want    string
		offered string
		ok      bool
	}{
		{"exact", "ABCD2345", "ABCD2345", true},
		{"case folded", "ABCD2345", "abcd2345", true},
		{"trimmed", "ABCD2345", " ABCD2345 ", true},
		{"wrong", "ABCD2345", "ABCD2346", false},
		{"prefix is not enough", "ABCD2345", "ABCD", false},
		{"longer is not enough", "ABCD2345", "ABCD23456", false},
		{"empty offered", "ABCD2345", "", false},
		// An empty expectation must never match: it is the state of having no
		// code at all, not a code that anything satisfies.
		{"empty expectation matches nothing", "", "ABCD2345", false},
		{"empty against empty", "", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := CodeMatches(tc.want, tc.offered); got != tc.ok {
				t.Errorf("CodeMatches(%q, %q) = %v, want %v", tc.want, tc.offered, got, tc.ok)
			}
		})
	}
}

// --- the connection table ---

func TestConnTable(t *testing.T) {
	id, err := peer.Decode("12D3KooWA9hLzQqBFcHhSHiXqPXTPeXCXn9nZKNBg8pTQXpsMZ1a")
	if err != nil {
		t.Skipf("could not build a peer id: %v", err)
	}
	now := time.Now()

	t.Run("unknown peers are not connected", func(t *testing.T) {
		if newConnTable().Connected(id, now) {
			t.Error("an unknown peer was reported as connected")
		}
	})

	t.Run("opening connects, and it expires", func(t *testing.T) {
		tab := newConnTable()
		tab.Open(id, now)

		if !tab.Connected(id, now) {
			t.Error("not connected right after Open")
		}
		if !tab.Connected(id, now.Add(ConnTTL-time.Second)) {
			t.Error("expired early")
		}
		if tab.Connected(id, now.Add(ConnTTL+time.Second)) {
			t.Error("still connected past the TTL")
		}
	})

	t.Run("touch extends a live connection", func(t *testing.T) {
		tab := newConnTable()
		tab.Open(id, now)

		later := now.Add(ConnTTL - time.Minute)
		tab.Touch(id, later)
		if !tab.Connected(id, later.Add(ConnTTL-time.Second)) {
			t.Error("Touch did not extend the connection")
		}
	})

	// Otherwise a peer could keep itself connected forever by touching after it
	// had already lapsed, which is exactly the case the TTL exists for.
	t.Run("touch does not revive a lapsed connection", func(t *testing.T) {
		tab := newConnTable()
		tab.Open(id, now)

		after := now.Add(ConnTTL + time.Minute)
		tab.Touch(id, after)
		if tab.Connected(id, after) {
			t.Error("Touch revived an expired connection")
		}
	})

	t.Run("forget closes immediately", func(t *testing.T) {
		tab := newConnTable()
		tab.Open(id, now)
		tab.Forget(id)

		if tab.Connected(id, now) {
			t.Error("still connected after Forget")
		}
	})

	t.Run("sweep drops only what has expired", func(t *testing.T) {
		tab := newConnTable()
		tab.Open(id, now)

		tab.Sweep(now.Add(time.Minute))
		if !tab.Connected(id, now.Add(time.Minute)) {
			t.Error("sweep dropped a live connection")
		}

		tab.Sweep(now.Add(ConnTTL + time.Minute))
		if len(tab.m) != 0 {
			t.Errorf("sweep left %d expired entries", len(tab.m))
		}
	})
}

func TestConnReqAnswer(t *testing.T) {
	newReq := func() *connReq {
		return &connReq{codeHash: HashPIN("ABCD2345"), decision: make(chan bool, 1)}
	}

	t.Run("the right code releases the handler", func(t *testing.T) {
		r := newReq()
		matched, _ := r.Answer("ABCD2345")
		if !matched {
			t.Fatal("the right code did not match")
		}
		select {
		case ok := <-r.decision:
			if !ok {
				t.Error("the handler was released with a refusal")
			}
		default:
			t.Error("the handler was never released")
		}
	})

	t.Run("wrong codes count down", func(t *testing.T) {
		r := newReq()
		for i := 1; i <= MaxCodeAttempts; i++ {
			matched, remaining := r.Answer("WRONGCOD")
			if matched {
				t.Fatalf("attempt %d matched", i)
			}
			if want := MaxCodeAttempts - i; remaining != want {
				t.Errorf("attempt %d: remaining = %d, want %d", i, remaining, want)
			}
		}
		select {
		case ok := <-r.decision:
			if ok {
				t.Error("running out of attempts accepted the connection")
			}
		default:
			t.Error("running out of attempts did not release the handler")
		}
	})

	// Once it is settled it stays settled — otherwise a late answer could
	// reopen a request its user had already refused.
	t.Run("a settled request accepts nothing further", func(t *testing.T) {
		r := newReq()
		r.Decline()

		if matched, _ := r.Answer("ABCD2345"); matched {
			t.Error("a declined request still accepted the right code")
		}
	})

	t.Run("decline is idempotent", func(t *testing.T) {
		r := newReq()
		r.Decline()
		r.Decline()

		if len(r.decision) != 1 {
			t.Errorf("decision channel holds %d values, want 1", len(r.decision))
		}
	})
}

// --- a peer in the middle of a transfer is not "gone" ---

// The bug this guards: a large transfer outlasts PeerTTL, mDNS says nothing in
// the meantime, and the sweep declares the peer lost — which took its dinosaur
// off the map and the dialog off the screen while the bytes were still moving.
func TestSweepKeepsAPeerThatIsTransferring(t *testing.T) {
	n := New(nil)
	id := testPeerID(t)

	old := time.Now().Add(-2 * PeerTTL)
	n.peers[id] = &peerRec{announced: true, lastSeen: old}

	release := n.beginTransfer(id)
	n.sweep(time.Now())

	if _, ok := n.peers[id]; !ok {
		t.Fatal("a peer mid-transfer was swept away")
	}
	// Its clock is refreshed too, so it does not expire the instant the
	// transfer ends.
	if got := n.peers[id].lastSeen; !got.After(old) {
		t.Error("lastSeen was not refreshed while transferring")
	}

	// Once the transfer is done the ordinary TTL applies again.
	release()
	n.peers[id].lastSeen = old
	n.sweep(time.Now())
	if _, ok := n.peers[id]; ok {
		t.Error("a stale peer survived the sweep after its transfer ended")
	}
}

func TestTransferringTracksNesting(t *testing.T) {
	n := New(nil)
	id := testPeerID(t)

	if n.transferring(id) {
		t.Fatal("an idle peer reported as transferring")
	}

	first := n.beginTransfer(id)
	second := n.beginTransfer(id)
	if !n.transferring(id) {
		t.Fatal("not reported as transferring")
	}

	// Two concurrent transfers with one peer — sending config while receiving
	// files, say — must not have the first to finish clear the flag.
	first()
	if !n.transferring(id) {
		t.Error("the flag cleared while a second transfer was still running")
	}
	second()
	if n.transferring(id) {
		t.Error("still transferring after everything finished")
	}
}

// testPeerID returns a valid peer ID for tests that only need a map key.
func testPeerID(t *testing.T) peer.ID {
	t.Helper()
	id, err := peer.Decode("12D3KooWA9hLzQqBFcHhSHiXqPXTPeXCXn9nZKNBg8pTQXpsMZ1a")
	if err != nil {
		t.Skipf("could not build a peer id: %v", err)
	}
	return id
}
