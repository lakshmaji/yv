---
"yv": patch
---

Fix releases publishing no installers.

`v0.2.0` was a bare tag: the DMG, Windows installer, `.deb` and AppImage were all
built, but nothing ever attached them. The tag was pushed with the automatic
`GITHUB_TOKEN`, and GitHub suppresses workflow triggers for that token, so the
build workflow never saw the tag — and the job that pushed it exited 0, so the
failure was invisible.

Tagging now runs through `changesets/action` with a `RELEASE_TOKEN`, which also
opens the Release with the changelog entry as its body; the build workflow uploads
the installers onto it. The hand-rolled versioning shell and both `workflow_dispatch`
triggers are gone.
