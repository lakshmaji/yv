package share

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"os"
	"strings"
)

// HashPIN returns the SHA-256 of a PIN, or "" for an empty PIN.
//
// Returning "" rather than the hash of the empty string is the whole point: ""
// is the sentinel for "no PIN configured", and if we hashed it, a peer that
// sent an empty PIN would match a receiver that had set none — which is
// harmless — but a receiver checking `if hash != ""` to mean "I require a PIN"
// would be wrong. One sentinel, one meaning.
func HashPIN(pin string) string {
	pin = strings.TrimSpace(pin)
	if pin == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(pin))
	return hex.EncodeToString(sum[:])
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
