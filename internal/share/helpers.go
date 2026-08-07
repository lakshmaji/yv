package share

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// PINLength is how many characters a generated share PIN has.
const PINLength = 8

// pinAlphabet is what a generated PIN is drawn from.
//
// Uppercase and digits with the homoglyphs removed — no O or 0, no I, L or 1 —
// because this code's entire job is to be read off one screen and typed on
// another, and a transcription error surfaces only as a flat refusal with no
// hint about which character was wrong. 31 symbols over 8 places is ~8.5e11
// combinations, which is far beyond what the receiver's per-peer throttle would
// let anyone work through.
const pinAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

// GeneratePIN returns a fresh share PIN.
//
// The user never chooses or types this on the device that owns it: one is drawn
// per connection request, shown on screen, and read out to whoever is trying to
// connect. crypto/rand because a predictable code is not a lock.
func GeneratePIN() (string, error) {
	out := make([]byte, 0, PINLength)

	// Rejection sampling: 31 does not divide 256, so a plain modulo would make
	// the first few letters of the alphabet measurably likelier than the rest.
	// 248 is the largest multiple of 31 that fits in a byte.
	const limit = 248
	buf := make([]byte, PINLength)

	for len(out) < PINLength {
		if _, err := rand.Read(buf); err != nil {
			return "", fmt.Errorf("generate PIN: %w", err)
		}
		for _, b := range buf {
			if b >= limit {
				continue
			}
			out = append(out, pinAlphabet[int(b)%len(pinAlphabet)])
			if len(out) == PINLength {
				break
			}
		}
	}
	return string(out), nil
}

// NormalizePIN puts a PIN in the one form that is compared and stored.
//
// Case is folded because the code is transcribed by hand: refusing a correct
// PIN because it was typed in lower case would be indistinguishable, from the
// outside, from getting it wrong. Generated PINs are uppercase already, and
// folding digits is a no-op, so a PIN set before this existed still matches.
func NormalizePIN(pin string) string {
	return strings.ToUpper(strings.TrimSpace(pin))
}

// HashPIN returns the SHA-256 of a PIN, or "" for an empty PIN.
//
// Returning "" rather than the hash of the empty string is the whole point: ""
// is the sentinel for "no PIN configured", and if we hashed it, a peer that
// sent an empty PIN would match a receiver that had set none — which is
// harmless — but a receiver checking `if hash != ""` to mean "I require a PIN"
// would be wrong. One sentinel, one meaning.
func HashPIN(pin string) string {
	pin = NormalizePIN(pin)
	if pin == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(pin))
	return hex.EncodeToString(sum[:])
}

// CodeMatches compares a connection code against the one on screen.
//
// Constant-time, and length-checked first: an eight-character code drawn from
// 31 symbols is small enough that leaking a matching prefix through timing
// would turn a hopeless search into a feasible one.
func CodeMatches(want, offered string) bool {
	w, o := NormalizePIN(want), NormalizePIN(offered)
	if w == "" || len(w) != len(o) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(w), []byte(o)) == 1
}

// PINMatches reports whether an offered PIN satisfies the stored hash.
//
// An empty want means no PIN is configured and anything passes. The comparison
// is constant-time: a 6-digit PIN is small enough that leaking a match prefix
// through timing would meaningfully narrow a guess.
func PINMatches(want, offered string) bool {
	if want == "" {
		return true
	}
	got := HashPIN(offered)
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

// NormalizeName cleans a hostname for display, falling back to a short peer ID.
//
// The name is not cosmetic — it seeds the dinosaur's appearance and its roar, so
// it must be non-empty and stable. macOS reports hostnames as "Rexy.local",
// which would read oddly on screen and, worse, would differ from the same
// machine seen over a non-mDNS transport, giving one device two dinosaurs.
func NormalizeName(hostname, peerID string) string {
	name := strings.TrimSpace(hostname)
	name = strings.TrimSuffix(name, ".")
	name = strings.TrimSuffix(name, ".local")
	name = strings.TrimSpace(name)

	if name != "" {
		return name
	}
	return ShortPeerID(peerID)
}

// ShortPeerID renders a peer ID as a recognisable stub. Peer IDs are ~52
// characters of base58, and the leading "12D3KooW" prefix is shared by every
// Ed25519 peer, so the tail is what actually distinguishes them.
func ShortPeerID(id string) string {
	if id == "" {
		return "unknown device"
	}
	if len(id) <= 8 {
		return id
	}
	return "device " + id[len(id)-6:]
}

// LocalName is this machine's display name, resolved once at startup.
func LocalName() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return NormalizeName(h, "")
}
