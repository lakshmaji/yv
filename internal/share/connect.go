package share

import (
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// ConnTTL is how long an accepted connection lasts. It has to cover the sender
// browsing for a file, so it is minutes rather than seconds — but it does
// expire, so a device that connected once is not connected forever.
const ConnTTL = 15 * time.Minute

// MaxCodeAttempts is how many times the receiving user may mistype a connection
// code before the request is dropped.
//
// The code never crosses the network in the clear and is only ever entered by
// hand on this device, so there is no remote guessing to rate-limit — this is
// here so a request left on screen cannot be worked through by someone sitting
// at the keyboard.
const MaxCodeAttempts = 5

// connTable records which peers are currently allowed to send us something.
//
// Swept lazily on access rather than on a ticker: entries only matter while a
// peer is talking to us, so anything stale is by definition idle and costs
// nothing until the next look.
type connTable struct {
	mu sync.Mutex
	m  map[peer.ID]time.Time // peer -> expiry

	// trusted holds peers paired once already this running session, under the
	// SharePairingOnce policy. It has no expiry and is not swept: unlike m, it
	// is meant to last as long as the node does. It is cleared with the rest
	// of the table on teardown regardless, because peer identity is not
	// persisted across a restart either — remembering past that point would
	// remember nothing real.
	trusted map[peer.ID]bool
}

func newConnTable() *connTable {
	return &connTable{m: make(map[peer.ID]time.Time), trusted: make(map[peer.ID]bool)}
}

// Open marks a peer as connected, starting its clock.
func (t *connTable) Open(id peer.ID, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.m[id] = now.Add(ConnTTL)
}

// OpenSession marks a peer as connected for the rest of this running session,
// with no expiry. This is what the SharePairingOnce policy remembers, so the
// same peer is not asked for a code again until this node stops.
func (t *connTable) OpenSession(id peer.ID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, id)
	t.trusted[id] = true
}

// Connected reports whether a peer may currently offer us a transfer.
func (t *connTable) Connected(id peer.ID, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.trusted[id] {
		return true
	}
	exp, ok := t.m[id]
	return ok && now.Before(exp)
}

// Touch extends a live connection, so a long browse for a file does not expire
// the connection that is plainly still in use.
func (t *connTable) Touch(id peer.ID, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if exp, ok := t.m[id]; ok && now.Before(exp) {
		t.m[id] = now.Add(ConnTTL)
	}
}

// Forget closes a peer's connection immediately, including a session-trusted
// one — so a device that was let in earlier under SharePairingOnce has to ask
// again too.
func (t *connTable) Forget(id peer.ID) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.m, id)
	delete(t.trusted, id)
}

// Sweep drops connections that have run out.
func (t *connTable) Sweep(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()

	for id, exp := range t.m {
		if !now.Before(exp) {
			delete(t.m, id)
		}
	}
}

// connReq is an inbound connection request waiting on its user.
//
// codeHash is what the sender's code hashes to. The plaintext never arrives, so
// this device cannot display the code even by accident — the only way its user
// gets it is from the person asking to connect, which is the entire point of
// the step.
type connReq struct {
	peer     peer.ID
	fromName string
	codeHash string

	mu       sync.Mutex
	attempts int
	done     bool
	decision chan bool
}

// Answer checks a typed code and, if it matches, releases the waiting handler.
//
// Reports whether the code was right, and how many attempts remain — the dialog
// says so, because "wrong code" with a silent counter behind it is how someone
// loses a request without understanding why.
func (r *connReq) Answer(code string) (matched bool, remaining int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.done {
		return false, 0
	}

	if PINMatches(r.codeHash, code) {
		r.done = true
		select {
		case r.decision <- true:
		default:
		}
		return true, 0
	}

	r.attempts++
	remaining = MaxCodeAttempts - r.attempts
	if remaining <= 0 {
		r.done = true
		select {
		case r.decision <- false:
		default:
		}
		return false, 0
	}
	return false, remaining
}

// Decline releases the waiting handler with a refusal.
func (r *connReq) Decline() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.done {
		return
	}
	r.done = true
	select {
	case r.decision <- false:
	default:
	}
}
