package updatesign

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Releases are signed with 4096-bit keys. The tests use 2048 because key
// generation dominates their runtime and the scheme is identical either way.
func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return key
}

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "artifact.bin")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSignAndVerifyRoundTrip(t *testing.T) {
	key := testKey(t)
	hash, err := HashFile(writeFile(t, "the release"))
	if err != nil {
		t.Fatalf("HashFile: %v", err)
	}

	sig, err := Sign(key, hash)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if err := Verify(&key.PublicKey, hash, sig); err != nil {
		t.Errorf("Verify: %v", err)
	}
}

// The whole point of the signature: a modified artifact hashes differently, so
// the signature no longer matches.
func TestTamperedArtifactFailsVerification(t *testing.T) {
	key := testKey(t)

	original, err := HashFile(writeFile(t, "the release"))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(key, original)
	if err != nil {
		t.Fatal(err)
	}

	tampered, err := HashFile(writeFile(t, "the release, plus something"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(&key.PublicKey, tampered, sig); !errors.Is(err, ErrBadSignature) {
		t.Errorf("err = %v, want ErrBadSignature", err)
	}
}

// A correctly-formed signature from a key we do not trust is the attack this
// exists to stop: anyone can generate a keypair and sign their own DMG.
func TestSignatureFromAnUntrustedKeyIsRefused(t *testing.T) {
	ours, theirs := testKey(t), testKey(t)

	hash, err := HashFile(writeFile(t, "a hostile release"))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(theirs, hash)
	if err != nil {
		t.Fatal(err)
	}

	if err := Verify(&ours.PublicKey, hash, sig); !errors.Is(err, ErrBadSignature) {
		t.Errorf("err = %v, want ErrBadSignature", err)
	}
}

func TestVerifyRejectsMalformedInput(t *testing.T) {
	key := testKey(t)
	hash, err := HashFile(writeFile(t, "x"))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(key, hash)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		hash    string
		sig     string
		wantErr string
	}{
		{"signature not base64", hash, "not!base64", "base64"},
		{"signature is empty", hash, "", "does not match"},
		{"signature is truncated", hash, sig[:len(sig)-8], "does not match"},
		{"hash not hex", "zz" + hash[2:], sig, "not hex"},
		{"hash too short", hash[:32], sig, "want 32"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Verify(&key.PublicKey, tt.hash, tt.sig)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want one mentioning %q", err, tt.wantErr)
			}
		})
	}
}

// The interop detail, pinned because getting it wrong is invisible: the digest
// covers the 32 *decoded* bytes of the file hash, not its 64-character hex
// spelling. Signing the string instead produces signatures that verify perfectly
// against themselves and against nothing the hot-updater tooling produces.
func TestSigningDigestCoversTheDecodedHashNotItsHexSpelling(t *testing.T) {
	fileHash := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

	got, err := SigningDigest(fileHash)
	if err != nil {
		t.Fatalf("SigningDigest: %v", err)
	}

	raw, _ := hex.DecodeString(fileHash)
	want := sha256.Sum256(raw)
	if got != want {
		t.Errorf("digest = %x, want %x (SHA-256 of the decoded bytes)", got, want)
	}

	if overHex := sha256.Sum256([]byte(fileHash)); got == overHex {
		t.Error("digest was taken over the hex string, not the decoded bytes")
	}
}

// The signature must be verifiable by a plain rsa.VerifyPKCS1v15 over that
// digest, without going through this package. That is what a reimplementation in
// another language — the Node signer this scheme is shared with — actually does.
func TestSignatureIsPlainPKCS1v15OverTheDigest(t *testing.T) {
	key := testKey(t)
	hash, err := HashFile(writeFile(t, "cross-checked"))
	if err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(key, hash)
	if err != nil {
		t.Fatal(err)
	}

	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		t.Fatalf("signature is not base64: %v", err)
	}
	decoded, _ := hex.DecodeString(hash)
	digest := sha256.Sum256(decoded)

	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], raw); err != nil {
		t.Errorf("independent verification failed: %v", err)
	}
}

func TestHashFileMatchesSHA256(t *testing.T) {
	const content = "some bytes"
	got, err := HashFile(writeFile(t, content))
	if err != nil {
		t.Fatalf("HashFile: %v", err)
	}
	want := sha256.Sum256([]byte(content))
	if got != hex.EncodeToString(want[:]) {
		t.Errorf("HashFile = %s, want %x", got, want)
	}
}

func TestHashFileReportsAMissingFile(t *testing.T) {
	if _, err := HashFile(filepath.Join(t.TempDir(), "absent")); err == nil {
		t.Error("hashed a file that does not exist")
	}
}

// Both `openssl genrsa` (PKCS#1) and `openssl genpkey` (PKCS#8) are things a
// person will reasonably run, so both have to parse. Accepting only one fails
// with an ASN.1 error that says nothing about which command to have used.
func TestParsePrivateKeyAcceptsBothPEMLayouts(t *testing.T) {
	key := testKey(t)

	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name  string
		block *pem.Block
	}{
		{"PKCS#1, from openssl genrsa", &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}},
		{"PKCS#8, from openssl genpkey", &pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePrivateKey(pem.EncodeToMemory(tt.block))
			if err != nil {
				t.Fatalf("ParsePrivateKey: %v", err)
			}
			if !got.Equal(key) {
				t.Error("parsed a different key")
			}
		})
	}
}

func TestParseKeysRejectNonsense(t *testing.T) {
	key := testKey(t)
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub})

	t.Run("private key that is not PEM", func(t *testing.T) {
		if _, err := ParsePrivateKey([]byte("hello")); err == nil {
			t.Error("accepted a non-PEM private key")
		}
	})
	t.Run("public key that is not PEM", func(t *testing.T) {
		if _, err := ParsePublicKey([]byte("hello")); err == nil {
			t.Error("accepted a non-PEM public key")
		}
	})
	t.Run("public key where a private one belongs", func(t *testing.T) {
		if _, err := ParsePrivateKey(pubPEM); err == nil {
			t.Error("accepted a public key as a private one")
		}
	})
	t.Run("public key round trip", func(t *testing.T) {
		got, err := ParsePublicKey(pubPEM)
		if err != nil {
			t.Fatalf("ParsePublicKey: %v", err)
		}
		if !got.Equal(&key.PublicKey) {
			t.Error("parsed a different key")
		}
	})
}
