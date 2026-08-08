// Package updatesign is the signing scheme for release artifacts, shared by the
// signer (cmd/sign-artifact, which runs in CI holding the private key) and the
// verifier (internal/updater, which holds only the public key).
//
// Both live here on purpose. A signer and a verifier that each implement "what
// gets signed" independently will eventually disagree, and the failure mode is
// that every update is refused as tampered — with nothing in either codebase
// looking wrong.
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
	"fmt"
	"io"
	"os"
)

// RSA PKCS#1 v1.5 over SHA-256, with 4096-bit keys.
//
// The scheme is deliberately identical to the one the hot-updater bundle signing
// uses, so there is one key-generation recipe and one mental model across both
// projects rather than two schemes that look alike and are not.

// HashFile returns the lowercase hex SHA-256 of a file, streaming it rather than
// reading it in — these are DMGs and AppImages, not config.
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SigningDigest is what the signature is actually computed over, and the single
// reason this package exists.
//
// It is the SHA-256 of the *raw bytes* of the artifact's SHA-256 — a digest of a
// digest. That is not an accident and not redundancy: it is what the hot-updater
// signing does (Node's `createSign("RSA-SHA256").update(Buffer.from(hex,"hex"))`),
// and matching it byte for byte is what lets one key and one tool cover both.
//
// The subtle part is `from(hex, "hex")`: it is the 32 decoded bytes that are
// hashed, not the 64-character hex string. Signing the string instead produces a
// signature that verifies perfectly against itself and against nothing else.
func SigningDigest(fileHashHex string) ([32]byte, error) {
	raw, err := hex.DecodeString(fileHashHex)
	if err != nil {
		return [32]byte{}, fmt.Errorf("file hash is not hex: %w", err)
	}
	if len(raw) != sha256.Size {
		return [32]byte{}, fmt.Errorf("file hash is %d bytes, want %d", len(raw), sha256.Size)
	}
	return sha256.Sum256(raw), nil
}

// Sign produces the base64 signature published as the .sig sidecar.
func Sign(key *rsa.PrivateKey, fileHashHex string) (string, error) {
	digest, err := SigningDigest(fileHashHex)
	if err != nil {
		return "", err
	}
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// ErrBadSignature is returned for any signature that does not verify, whatever
// the reason.
//
// One value rather than several, because the caller has exactly one action
// available — refuse the artifact — and distinguishing "wrong key" from
// "tampered" for a user would be guessing at which anyway.
var ErrBadSignature = errors.New("signature does not match")

// Verify checks a base64 signature against an artifact's hex SHA-256.
func Verify(pub *rsa.PublicKey, fileHashHex, signatureB64 string) error {
	digest, err := SigningDigest(fileHashHex)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("%w: not valid base64", ErrBadSignature)
	}
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
		return ErrBadSignature
	}
	return nil
}

// ParsePrivateKey reads a PEM private key, accepting both the PKCS#8 that
// `openssl genpkey` writes and the PKCS#1 that `openssl genrsa` writes.
//
// Both are labelled "PRIVATE KEY" or "RSA PRIVATE KEY" respectively and both are
// things a person will reasonably produce, so accepting only one would fail with
// an ASN.1 parse error that says nothing about which command to have run.
func ParsePrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("not a PEM block — expected a -----BEGIN … PRIVATE KEY----- file")
	}

	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("key is %T, want RSA", key)
		}
		return rsaKey, nil
	}

	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("could not parse the private key as PKCS#8 or PKCS#1: %w", err)
	}
	return key, nil
}

// ParsePublicKey reads a PEM PKIX public key — what `openssl rsa -pubout` writes.
func ParsePublicKey(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("not a PEM block — expected a -----BEGIN PUBLIC KEY----- file")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("could not parse the public key: %w", err)
	}
	pub, ok := key.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("key is %T, want RSA", key)
	}
	return pub, nil
}
