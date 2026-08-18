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

## yv installs per-user, and that is what makes it able to update itself.
##
## internal/updater replaces the running executable in place — it renames it
## aside and unpacks the release zip over the install directory. InstallCheck
## (internal/updater/apply.go) proves it can write there by writing there, and a
## Program Files install fails that test for every account that is not elevated.
## The dialog then offers the releases page instead of a download, which is the
## behaviour this pair of defines exists to remove.
##
## Both are read by wails_tools.nsh with !ifndef, so they have to be defined
## *before* the include below and not after it.
##
##   REQUEST_EXECUTION_LEVEL  RequestExecutionLevel user; makes
##                            wails.setShellContext choose the current user's
##                            Start menu and Desktop rather than all-users, and
##                            makes wails.webview2runtime also accept a
##                            per-user WebView2 as already installed.
##   WAILS_INSTALL_SCOPE      Writes the Add/Remove Programs entry to HKCU, so
##                            the unelevated uninstaller can delete it again.
!define REQUEST_EXECUTION_LEVEL "user"
!define WAILS_INSTALL_SCOPE "user"

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

# The installer no longer elevates, so launching from it hands yv the same
# ordinary user token it would get from the Start menu. Ticked by default: the
# reason it used to be offered rather than automatic was that first session
# running as administrator, and that reason is gone.
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"

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

# Programs\ under LOCALAPPDATA is where a Windows per-user install goes, and it
# is writable by the account that runs yv — see the note above the defines.
#
# The template nests this under ${INFO_COMPANYNAME} — "…\Programs\Personal\yv".
# yv is not a suite, so the company level is a folder with one thing in it.
InstallDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
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

    !insertmacro wails.writeUninstaller
SectionEnd

Section "uninstall"
    !insertmacro wails.setShellContext

    RMDir /r "$AppData\${PRODUCT_EXECUTABLE}" # Remove the WebView2 DataPath

    RMDir /r $INSTDIR

    Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

    !insertmacro wails.unassociateFiles
    !insertmacro wails.unassociateCustomProtocols

    !insertmacro wails.deleteUninstaller
SectionEnd
