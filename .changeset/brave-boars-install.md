---
"yv": minor
---

Proper installers, and a fix for device sharing between machines that both
have a firewall.

**Windows now has an installer.** It puts yv in Program Files with a
Start-menu entry and an uninstaller, installs the WebView2 runtime if it is
missing (without which the app started and died with no window), and allows
yv through Windows Firewall on private networks. The portable `.zip` is
still there for anyone who would rather not install anything.

**The macOS disk image now shows what to do with it** — yv beside an
Applications shortcut, so it gets dragged somewhere it can update itself
from. Opening it and double-clicking used to run yv off the disk image,
which then refused every update.

**Device sharing works between two firewalled machines.** Sharing needs to
accept incoming connections, and two computers that both block them could
find each other and never connect — each worked fine against a third
machine, which made it look like one of them was broken. When it still
cannot connect, the Discovery view now says so and names the fix, instead of
reporting an empty network.

The app icon is no longer the stock Wails placeholder, and on Windows the
Help and View menus show real shortcut names instead of `Ctrl+OEM2`.
