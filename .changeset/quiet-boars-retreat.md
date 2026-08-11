---
"yv": patch
---

Fixed device discovery on macOS, which stopped finding anything after 0.2.0.

The macOS app bundle had picked up a `NSBonjourServices` entry naming the wrong
kind of service. That key restricts an app to the service types it lists, so an
entry that matches nothing stops the app announcing itself and browsing for
others — in both directions, which is why a Mac and a Linux machine that used to
find each other went quiet at the same moment.

Reverted along with the rest of the change it shipped in: the Windows installer
no longer adds firewall rules, and the "found, but not reachable" wording in the
no-devices dialog is gone for now. The firewall diagnosis those were built on was
never actually measured, and on the affected Mac the firewall was switched off
the whole time.
