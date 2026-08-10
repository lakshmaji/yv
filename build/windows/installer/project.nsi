Unicode true

####
## yv's NSIS installer.
##
## Started from the Wails template and edited. Two things about this file are
## worth knowing before touching it:
##
##  1. `wails build -nsis` writes this file only if it is *missing*, so the
##     edits below survive a build. Its sibling wails_tools.nsh is rewritten
##     from the template on every build — editing that one accomplishes nothing.
##  2. A missing `makensis` is only a warning to `wails build`, not an error, so
##     nothing here can tell you the installer was skipped. The CI step asserts
##     the output file exists instead.
##
## Building it by hand, once a `-nsis` build has populated wails_tools.nsh and
## downloaded the WebView2 bootstrapper into tmp/:
##
##   makensis -DARG_WAILS_AMD64_BINARY=..\..\bin\yv.exe project.nsi
##
## That is exactly what CI re-runs when the executable has been code-signed,
## because `wails build -nsis` relinks the exe and would discard the signature.
####
## Values not defined here are populated by wails_tools.nsh from wails.json:
## INFO_PROJECTNAME, INFO_COMPANYNAME, INFO_PRODUCTNAME, INFO_PRODUCTVERSION,
## INFO_COPYRIGHT, PRODUCT_EXECUTABLE, REQUEST_EXECUTION_LEVEL.
####

## The uninstall key is the Add/Remove Programs entry. The default is
## ${INFO_COMPANYNAME}${INFO_PRODUCTNAME}, which for wails.json's companyName
## would read "Personalyv".
!define UNINST_KEY_NAME "yv"

!include "wails_tools.nsh"

# The version information for this two must consist of 4 parts
VIProductVersion "${INFO_PRODUCTVERSION}.0"
VIFileVersion    "${INFO_PRODUCTVERSION}.0"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Installer"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

# Enable HiDPI support. https://nsis.sourceforge.io/Reference/ManifestDPIAware
ManifestDPIAware true

!include "MUI.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_FINISHPAGE_NOAUTOCLOSE # Wait on the INSTFILES page so the user can take a look into the details of the installation steps
!define MUI_ABORTWARNING # This will warn the user if they exit from the installer.

# Offered rather than automatic: the installer runs elevated, and launching yv
# from it would leave the app running as administrator for that first session.
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME # Welcome to the installer page.
!insertmacro MUI_PAGE_DIRECTORY # In which folder install page.
!insertmacro MUI_PAGE_INSTFILES # Installing page.
!insertmacro MUI_PAGE_FINISH # Finished installation page.

!insertmacro MUI_UNPAGE_INSTFILES # Uinstalling page

!insertmacro MUI_LANGUAGE "English" # Set the Language of the installer

## Signing is done by the CI workflow, which holds the certificate, rather than
## by a `!finalize` here — makensis is also run locally, where there is none.
#!uninstfinalize 'signtool --file "%1"'
#!finalize 'signtool --file "%1"'

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe" # Name of the installer's file.

# The template nests this under ${INFO_COMPANYNAME} — "Program Files\Personal\yv".
# yv is not a suite, so the company level is a folder with one thing in it.
InstallDir "$PROGRAMFILES64\${INFO_PRODUCTNAME}"
ShowInstDetails show # This will always show the installation details.

Function .onInit
   !insertmacro wails.checkArchitecture
FunctionEnd

Section
    !insertmacro wails.setShellContext

    # Without the runtime the app starts and then dies with no window and no
    # message, so this check is the difference between "it doesn't work" and a
    # working install on a fresh machine.
    !insertmacro wails.webview2runtime

    SetOutPath $INSTDIR

    !insertmacro wails.files

    CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
    CreateShortCut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"

    !insertmacro wails.associateFiles
    !insertmacro wails.associateCustomProtocols

    # Device discovery needs to accept unsolicited inbound connections, and
    # Windows blocks those by default. Without a rule here, two machines that
    # both filter inbound can discover each other over mDNS and then never
    # connect — libp2p links are bidirectional, so a pair only works if at least
    # one end accepts. That failure is silent from the app's side, which is what
    # made it hard to diagnose the first time.
    #
    # Per-program, not per-port: the app binds ephemeral TCP and UDP ports
    # (internal/share/node.go listens on tcp/0 and udp/0), so they differ every
    # launch and no port rule could be written.
    #
    # private,domain and deliberately never public. Opening unsolicited inbound
    # on a café network is not something to do quietly on a user's behalf, and
    # yv's connect-code gate assumes a network the user chose to join.
    #
    # Note this is also why the portable .zip behaves differently: it has no
    # installer, so it never gets these rules.
    DetailPrint "Allowing yv through Windows Firewall (private networks)"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="yv (TCP-In)"'
    Pop $0
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="yv (UDP-In)"'
    Pop $0
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="yv (TCP-In)" dir=in action=allow program="$INSTDIR\${PRODUCT_EXECUTABLE}" protocol=TCP profile=private,domain enable=yes'
    Pop $0
    # Not fatal. A machine whose policy forbids this still runs yv perfectly
    # against a peer that accepts inbound, and the Discovery dialog now explains
    # the rest — so failing the whole install here would cost more than it saves.
    ${If} $0 != 0
        DetailPrint "Could not add the inbound TCP rule (code $0). yv will still run."
    ${EndIf}
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="yv (UDP-In)" dir=in action=allow program="$INSTDIR\${PRODUCT_EXECUTABLE}" protocol=UDP profile=private,domain enable=yes'
    Pop $0
    ${If} $0 != 0
        DetailPrint "Could not add the inbound UDP rule (code $0). yv will still run."
    ${EndIf}

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath

    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    # Leaving a firewall exception behind for a program that is no longer
    # installed is exactly the kind of stale hole nobody goes looking for.
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="yv (TCP-In)"'
    Pop $0
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="yv (UDP-In)"'
    Pop $0

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
