# Releasing yv

How a release is cut, and the two things about it that cannot be undone.

---

## Read this before your first release

**Two secrets and one file decide whether updates work at all.**

`YV_UPDATE_PRIVATE_KEY` signs every release artifact. The matching public key is
compiled into the app, in `updatePublicKeyPEM` in
[`internal/updater/signature.go`](./internal/updater/signature.go). An installed
copy trusts that key and nothing else.

Two consequences, both permanent:

- **Losing the private key means no installed copy can ever be updated again.**
  Not "until we fix it" — there is no fix. Every machine already out there will
  refuse anything signed by a replacement key, because it has never heard of it.
  Keep an offline copy somewhere you would keep a password manager's recovery
  code.
- **Rotating the key takes two releases, in order.** A build carrying the *new*
  public key has to reach people *before* CI starts signing with the *new*
  private key. Sign first and every installed copy refuses the very update that
  would have taught it the new key.

Until the key exists, the app builds and runs perfectly and simply reports that
it cannot install updates. That is deliberate: no key means no way to tell a real
release from anything else, and the honest answer is better than a hopeful one.

---

## One-time setup

### 1. Generate the signing keypair

```bash
make update-keys
```

Writes `yv-update-private.pem` (mode 0600) and `yv-update-public.pem`. Neither is
committed — `.gitignore` covers both, as a backstop rather than as the reason.

The target refuses to overwrite an existing private key. A second run would
replace the key every installed copy trusts, and nothing would reveal that until
updates started being refused in the field.

### 2. Compile in the public key

Paste the contents of `yv-update-public.pem` into `updatePublicKeyPEM` in
`internal/updater/signature.go`, and commit it. A Go test checks it parses; the
app reports `ErrNoTrustedKey` while it is empty.

### 3. Store the private key

Add the contents of `yv-update-private.pem` as the repository secret
**`YV_UPDATE_PRIVATE_KEY`**, then put a copy somewhere offline. Delete the local
file once both are done.

### 4. Optional: `RELEASE_TOKEN`

A tag pushed with the default `GITHUB_TOKEN` does not start another workflow —
GitHub blocks that so a workflow cannot loop on itself — so `build.yml` would
never see it. A `RELEASE_TOKEN` secret (a PAT with `contents: write`) makes the
handoff automatic. Without it the tag is still created and the job summary prints
the one command needed to start the build by hand.

---

## Cutting a release

### 1. Every PR carries a changeset

```bash
bun changeset
```

Pick patch / minor / major and write a line describing the change **for someone
deciding whether to install it**. That line is not just changelog: it is the
release body, and the release body is what the update dialog shows.

### 2. Version

Run the **Release** workflow from the Actions tab with `version` checked. It
consumes the pending changesets, bumps `package.json`, writes `CHANGELOG.md`,
mirrors the number into `wails.json`, and opens a PR.

Or locally:

```bash
bun run version    # changeset version && node scripts/sync-version.mjs
```

Both files must move together. `version_test.go` fails the build if they drift,
because a mismatch ships a `.deb` whose package version disagrees with the binary
inside it — and the updater then compares the wrong number.

### 3. Merge, and the tag follows

Merging the version PR trips the `tag` job, which pushes `v<version>`.

### 4. Build publishes

The tag starts `build.yml`, which:

- checks the tag matches `package.json` and `wails.json` (in the test job, so a
  mismatch costs two minutes rather than three platform builds);
- builds macOS, Windows and Linux, with `-ldflags -X main.version=<version>`;
- packages a DMG, a Windows `-setup.exe`, a `.zip`, a `.deb`, a tarball and an
  AppImage;
- writes a `.sha256` and a `.sig` beside every artifact;
- creates the GitHub Release with the CHANGELOG section as its body.

Two packaging tools are resolved by the workflow rather than assumed: `create-dmg`
(installed with brew; the DMG script falls back to a plain image without it) and
`makensis` (present in the Windows runner image but not on `PATH`). The NSIS one is
checked explicitly because `wails build -nsis` treats a missing `makensis` as a
warning and exits 0 — a green build with no installer in the release.

**The signing step fails the build if `YV_UPDATE_PRIVATE_KEY` is unset.** That is
on purpose. An unsigned release looks complete, downloads fine, and is refused by
every machine it reaches — failing loudly beats publishing that.

---

## Which artifact updates itself

| Platform | Install | Self-updates |
|---|---|---|
| macOS | `.dmg` → drag to Applications | yes |
| Windows | `-setup.exe` (installer) | yes, via the `.zip` |
| Windows | `.zip` → unpack anywhere (portable) | yes |
| Linux | `.AppImage` | yes |
| Linux | `.deb` | **no** — use `apt` |
| Linux | `.tar.gz` | **no** |

The Windows `.zip` has to be published whether or not anyone downloads it by
hand: `pickAsset` matches `-windows-amd64-` **and** a `.zip` suffix, and the
updater unpacks an archive because a running `.exe` cannot be overwritten in
place. Dropping it would leave every installed copy with "no download for this
platform", permanently. The installer is deliberately not matched — applying it
would mean a UAC prompt in the middle of an update the user already approved.

The `.deb` installs to root-owned `/usr/bin`, so replacing the binary would mean a
password prompt on every update *and* going behind dpkg's back, leaving apt
convinced the old version is installed. The tarball is a loose binary with nothing
identifying it as ours. Both are told to use their package manager rather than
offered a download that would not apply.

macOS additionally refuses to self-update when running from a disk image or from
the read-only copy Gatekeeper makes of a quarantined app. The dialog says which,
and what to do about it.

---

## Code signing

**Not set up yet** — there is no Apple Distribution certificate and no Windows
Authenticode certificate. The steps exist in `build.yml` behind a
`workflow_dispatch` input defaulting to false, so they never run on a push.

Keep the two kinds of signing straight:

|  | Gates | Needed for updates? |
|---|---|---|
| **Update signing** (RSA, this repo's key) | every install after the first | **yes**, mandatory |
| **OS code signing** (Apple / Authenticode) | the first install, by hand | no |

They are independent, which is why the updater ships today. What OS signing
changes is only the warning a new user sees downloading the app themselves:
Gatekeeper's "cannot be verified" on macOS, SmartScreen on Windows. Neither recurs
on an auto-update — the updater replaces files in place and never goes through the
browser download path that applies the quarantine attribute.

When the certificates arrive, add these secrets and run the workflow with
`signing` (and `notarize`) checked:

| Secret | For |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | its password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID` | notarization |
| `WINDOWS_CERTIFICATE` | base64 of the `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |

---

## Verifying a download by hand

```bash
shasum -a 256 -c yv-macos-arm64-v0.1.0.dmg.sha256
```

The `.sig` is an RSA-4096 PKCS#1 v1.5 signature over the SHA-256 of the **decoded
bytes** of that hash — a digest of a digest, matching the hot-updater bundle
signing scheme so one key and one tool cover both. `internal/updatesign` is the
only implementation; see `SigningDigest` for why the "decoded bytes" part matters.

---

## If something goes wrong

**The release published without sidecars.** Sign locally and upload them; nothing
else needs rebuilding.

```bash
gh release download v0.1.0 --dir dist --pattern '*'
YV_UPDATE_PRIVATE_KEY="$(cat yv-update-private.pem)" go run ./cmd/sign-artifact dist/*
gh release upload v0.1.0 dist/*.sha256 dist/*.sig
```

**The tag was pushed but nothing built.** No `RELEASE_TOKEN`. Re-push the tag from
a local checkout: `git push --force origin v0.1.0`.

**A user reports "cannot verify updates".** They are on a build made before the
public key was compiled in. They need to download once by hand; every release
after that updates normally.
