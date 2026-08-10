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
// Generated 2026-08 with `make update-keys`. The private half lives only in the
// YV_UPDATE_PRIVATE_KEY repository secret and an offline copy.
var updatePublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAtuOnvhQhztt8tW5UJtNM
HyXaIrSt3sXZzxCcsaiFwltlfThitH18XXpjPjKf49cP+g5b68Xv46C4mBbSsjud
kGgcTKELS1mkbl99MZC4cgJSURDx/rRMq8/JI9ecUzKeRnyDfTLNlNloiZ1h7TW3
6+Aii3qYfSii/eAOlbNHt8Iyukl7pgFyIPbHrO++q9eXLny/dXadokO8gSiaecOd
LOiowqHXzl2A+dZ65ciCF1FUnO9q4TEI6DwLU6zYGlyqSKEpdN+W16IqGgEARUIQ
dLnqSHN0JEAL3ydizPVizyJi3fFmzifHNx1wI4qLE3oUk216eXIuj7xu3kEwHxc0
3JXiUkFe/lRnmSaHA3uodb9Sqs59oCf/10AOrEL4jpXS9mxPclQxHHFs4j3fJ8ZD
Rv22vqBqBjpoJd3XfMPjlhYd1hfOW+UokpHEnKSNod277+AzTfCd6A0aKY5y/DdI
1NzUrJzjKzakQsm7M0+UrT+tSMuoAh8bJ2eyb+rhKdg4KoGl1XtpJ2LNNit7cvV6
YvKdAAM3Syd6uJBWDKGz27Ase5ZNAxLVFM2n8nsy9pkb26TOL9jedk/Y6xpYTaB2
od9P+Kz+nHB+Slrdut5ZcxnsQ7fWqajDaDE2TPCqaij9B7FbinvFvaFzHDRxgKnk
1JW4IvDnW6nywdQHAqoV7VUCAwEAAQ==
-----END PUBLIC KEY-----`

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
