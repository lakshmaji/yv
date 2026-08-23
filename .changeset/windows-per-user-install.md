---
"yv": patch
---

Windows updates now install themselves.

The updater could always replace a running `yv.exe` — rename it aside, unpack the
release zip over the install directory, relaunch, sweep the leftover on the next
launch. It never got to: the installer put yv in Program Files, the app runs
unelevated, and so the check that yv can write to its own directory failed. The
update dialog reported that honestly and offered the releases page instead, which
is the screen every Windows user has been seeing.

The installer is now per-user — `%LOCALAPPDATA%\Programs\yv`, no UAC prompt, its
Add/Remove Programs entry under `HKCU`. That directory is writable by the account
that runs yv, so the dialog offers Download and Restart like every other platform.

Run the new installer once; updates after that are in-app.
