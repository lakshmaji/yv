package updater

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"sync"

	"yv/internal/updatesign"
)

// updatePublicKeyPEM is the only key this build trusts to sign an update.
//
// Generate a pair with `make update-keys`, paste the *public* half here, and put
// the private half in the YV_UPDATE_PRIVATE_KEY repository secret. Never commit
// the private half; .gitignore covers *-private.pem, which is a backstop and not
// permission to keep it in the tree.
//
// Two things follow from the key being compiled in, and both are in RELEASING.md
// because neither is recoverable by pushing a fix:
//
//   - Rotating it needs a build carrying the *new* public key to reach people
//     *before* CI starts signing with the new private key. Sign first and every
//     installed copy refuses the update that would have taught it the new key.
//   - Losing the private key means no installed copy can ever be updated again.
//     They can only be replaced by hand.
//
// Empty until a key is generated. Every verification then fails, which is the
// correct direction to fail in: no key means no way to tell a real release from
// anything else, and the error below says exactly that rather than reporting a
// bad signature.
var updatePublicKeyPEM = ``

// ErrNoTrustedKey means this build shipped without a public key, so it cannot
// tell a genuine release from anything else.
var ErrNoTrustedKey = errors.New("this build has no update signing key")

var (
	trustedKeyOnce sync.Once
	trustedKey     *rsa.PublicKey
	trustedKeyErr  error
)

// trustedPublicKey parses the compiled-in key once. Parsing is deferred rather
// than done in an init so that a malformed key is an update failure with a
// message, not a binary that will not start.
func trustedPublicKey() (*rsa.PublicKey, error) {
	trustedKeyOnce.Do(func() {
		if updatePublicKeyPEM == "" {
			trustedKeyErr = ErrNoTrustedKey
			return
		}
		trustedKey, trustedKeyErr = updatesign.ParsePublicKey([]byte(updatePublicKeyPEM))
		if trustedKeyErr != nil {
			trustedKeyErr = fmt.Errorf("%w: %v", ErrNoTrustedKey, trustedKeyErr)
		}
	})
	return trustedKey, trustedKeyErr
}

// verifySignature checks a downloaded artifact's hash against the signature the
// release published, using the key compiled into this build.
func verifySignature(fileHashHex, signatureB64 string) error {
	pub, err := trustedPublicKey()
	if err != nil {
		return err
	}
	return updatesign.Verify(pub, fileHashHex, signatureB64)
}

// HasTrustedKey reports whether this build can verify an update at all.
//
// The UI asks before offering to download: pulling hundreds of megabytes that
// will certainly be refused at the end wastes someone's time and bandwidth, and
// the honest answer ("this build cannot install updates") is available up front.
func HasTrustedKey() bool {
	_, err := trustedPublicKey()
	return err == nil
}
