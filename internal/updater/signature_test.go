package updater

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"sync"
	"testing"

	"yv/internal/updatesign"
)

// withTrustedKey swaps the compiled-in public key for the run of one test.
//
// The sync.Once has to be reset alongside it, which is the reason this helper
// exists rather than each test assigning the var: the parse is cached, so a
// second test would silently keep the first one's key.
func withTrustedKey(t *testing.T, pemText string) {
	t.Helper()
	prev := updatePublicKeyPEM
	reset := func() {
		trustedKeyOnce = sync.Once{}
		trustedKey, trustedKeyErr = nil, nil
	}
	updatePublicKeyPEM = pemText
	reset()
	t.Cleanup(func() {
		updatePublicKeyPEM = prev
		reset()
	})
}

func keyPair(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

const artifactHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestVerifySignatureAcceptsTheTrustedKey(t *testing.T) {
	key, pubPEM := keyPair(t)
	withTrustedKey(t, pubPEM)

	sig, err := updatesign.Sign(key, artifactHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySignature(artifactHash, sig); err != nil {
		t.Errorf("verifySignature: %v", err)
	}
	if !HasTrustedKey() {
		t.Error("HasTrustedKey = false with a valid key compiled in")
	}
}

// Anyone can generate a keypair and sign their own DMG. Only ours counts.
func TestVerifySignatureRefusesAnotherKey(t *testing.T) {
	_, ourPubPEM := keyPair(t)
	theirKey, _ := keyPair(t)
	withTrustedKey(t, ourPubPEM)

	sig, err := updatesign.Sign(theirKey, artifactHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySignature(artifactHash, sig); !errors.Is(err, updatesign.ErrBadSignature) {
		t.Errorf("err = %v, want ErrBadSignature", err)
	}
}

// A build with no key cannot tell a genuine release from anything else, so it
// must refuse everything — and say why. Reporting a bad signature instead would
// send someone looking at the release rather than at the build.
func TestNoKeyMeansNoUpdates(t *testing.T) {
	key, _ := keyPair(t)
	withTrustedKey(t, "")

	sig, err := updatesign.Sign(key, artifactHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySignature(artifactHash, sig); !errors.Is(err, ErrNoTrustedKey) {
		t.Errorf("err = %v, want ErrNoTrustedKey", err)
	}
	if HasTrustedKey() {
		t.Error("HasTrustedKey = true with no key compiled in")
	}
}

// A malformed key is an update failure with a message, not a binary that refuses
// to start — which is why parsing is deferred rather than done in an init.
func TestMalformedKeyIsAnUpdateFailureNotACrash(t *testing.T) {
	withTrustedKey(t, "-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----\n")

	if err := verifySignature(artifactHash, "c2ln"); !errors.Is(err, ErrNoTrustedKey) {
		t.Errorf("err = %v, want ErrNoTrustedKey", err)
	}
	if HasTrustedKey() {
		t.Error("HasTrustedKey = true with an unparseable key")
	}
}

// The key shipped in this branch. Empty is the expected state until `make
// update-keys` has been run and the public half pasted in — the test states that
// rather than asserting it, so it fails loudly if someone pastes in something
// that does not parse.
func TestCompiledInKeyParsesIfPresent(t *testing.T) {
	if updatePublicKeyPEM == "" {
		t.Skip("no signing key compiled in yet — see RELEASING.md")
	}
	if _, err := updatesign.ParsePublicKey([]byte(updatePublicKeyPEM)); err != nil {
		t.Fatalf("the compiled-in public key does not parse: %v", err)
	}
}
