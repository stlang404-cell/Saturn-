; SATURN — Windows installer (Inno Setup 6)
; Builds a self-contained installer from the electron-builder "win-unpacked" output,
; which already contains the Electron runtime, the game, the llama.cpp inference
; backends (CPU + Vulkan) and the bundled GGUF model under resources\models.
;
; Why Inno Setup and not NSIS: the standard model alone is ~2.5 GB, and NSIS installers
; are limited to ~2 GB. Inno Setup handles large payloads with disk spanning
; (setup.exe + setup-1.bin ...), all of which ship together.
;
; Build (on Windows):  iscc /DAppVersion=0.1.0 /DSourceDir=..\dist\win32-x64\win-unpacked installer\saturn.iss

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\win32-x64\win-unpacked"
#endif

[Setup]
AppId={{6C1E8A52-7D3B-4E4A-9F0B-5A7E2C3D9B10}
AppName=SATURN
AppVersion={#AppVersion}
AppPublisher=SATURN contributors
AppVerName=SATURN — The Living World {#AppVersion}
DefaultDirName={autopf}\SATURN
DefaultGroupName=SATURN
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=SATURN-Setup-{#AppVersion}
Compression=lzma2/fast
SolidCompression=no
DiskSpanning=yes
DiskSliceSize=max
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
UninstallDisplayIcon={app}\SATURN.exe
; ~4.5 GB installed; 8 GB RAM recommended
ExtraDiskSpaceRequired=104857600

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\SATURN"; Filename: "{app}\SATURN.exe"
Name: "{autodesktop}\SATURN"; Filename: "{app}\SATURN.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SATURN.exe"; Description: "{cm:LaunchProgram,SATURN}"; Flags: nowait postinstall skipifsilent
