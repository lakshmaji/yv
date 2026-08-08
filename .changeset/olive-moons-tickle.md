---
"yv": minor
---

yv can now update itself. It checks GitHub for new releases, verifies the
download against an RSA signature before trusting it, and installs it — on
macOS, Windows, and the Linux AppImage. Package installs are told to use
their package manager rather than offered a download that would not apply.

Check from Help → Check for Updates…, or from About. A quiet check also runs
a few seconds after launch and only speaks up when there is something to say.
