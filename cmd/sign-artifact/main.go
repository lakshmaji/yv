// Command sign-artifact publishes the two sidecars that make a release
// installable: <artifact>.sha256 and <artifact>.sig.
//
//	YV_UPDATE_PRIVATE_KEY="$(cat yv-update-private.pem)" \
//	  go run ./cmd/sign-artifact dist/yv-macos-arm64-v0.1.0.dmg
//
// Both sidecars come from one tool rather than `shasum` writing one and this
// writing the other. The signature is computed over the hash, so two producers
// means two chances for them to describe different bytes — and the symptom of
// that is every update being refused as tampered.
//
// The key comes from the environment, never a flag: an argument is visible in
// `ps` and lands in CI logs whenever a command is echoed.
package main

import (
	"crypto/rsa"
	"fmt"
	"os"
	"path/filepath"

	"yv/internal/updatesign"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "sign-artifact:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: sign-artifact <artifact>…")
	}

	pemBytes := os.Getenv("YV_UPDATE_PRIVATE_KEY")
	if pemBytes == "" {
		return fmt.Errorf("YV_UPDATE_PRIVATE_KEY is not set — refusing to publish an artifact nobody can verify")
	}

	key, err := updatesign.ParsePrivateKey([]byte(pemBytes))
	if err != nil {
		return fmt.Errorf("YV_UPDATE_PRIVATE_KEY: %w", err)
	}

	for _, path := range args {
		if err := signOne(key, path); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(path), err)
		}
	}
	return nil
}

func signOne(key *rsa.PrivateKey, path string) error {
	// Stat first: a glob that matched a directory, or a packaging step that
	// silently produced nothing, should say so here rather than fail later with
	// an "is a directory" read error.
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("is a directory")
	}

	hash, err := updatesign.HashFile(path)
	if err != nil {
		return err
	}
	sig, err := updatesign.Sign(key, hash)
	if err != nil {
		return err
	}

	// The `shasum -a 256` layout, so anyone can check a download by hand with
	// `shasum -a 256 -c <file>.sha256` in the directory they downloaded into.
	name := filepath.Base(path)
	if err := write(path+".sha256", hash+"  "+name+"\n"); err != nil {
		return err
	}
	if err := write(path+".sig", sig+"\n"); err != nil {
		return err
	}

	fmt.Printf("  %s\n    sha256 %s\n", name, hash)
	return nil
}

func write(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}
