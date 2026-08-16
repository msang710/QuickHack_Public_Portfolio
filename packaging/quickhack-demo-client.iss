#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

#ifndef SourceDir
  #define SourceDir "..\release\demo-client"
#endif

#ifndef OutputDir
  #define OutputDir "..\release\distribution\windows\demo-client"
#endif
#ifndef ArtifactAppId
  #define ArtifactAppId "{7D88F75C-5D65-4B34-9DD6-EFB19332DD33}"
#endif
#ifndef ArtifactName
  #define ArtifactName "QuickHack Demo Client"
#endif
#ifndef ArtifactExe
  #define ArtifactExe "QuickHack-Demo-Client.exe"
#endif
#ifndef ArtifactFilePrefix
  #define ArtifactFilePrefix "QuickHack-Demo-Client"
#endif
#ifndef ArtifactGroup
  #define ArtifactGroup "QuickHack Demo"
#endif
#ifndef MutableRootName
  #define MutableRootName "demonstration-client"
#endif

[Setup]
AppId={#ArtifactAppId}
AppName={#ArtifactName}
AppVersion={#AppVersion}
AppPublisher=QuickHack
DefaultDirName={localappdata}\Programs\{#ArtifactName}
DefaultGroupName={#ArtifactGroup}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#ArtifactFilePrefix}-Setup-{#AppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#ArtifactExe}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#ArtifactName}"; Filename: "{app}\{#ArtifactExe}"; WorkingDir: "{app}"
Name: "{userdesktop}\{#ArtifactName}"; Filename: "{app}\{#ArtifactExe}"; WorkingDir: "{app}"

[Run]
Filename: "{app}\{#ArtifactExe}"; Description: "Open {#ArtifactName}"; Flags: postinstall nowait skipifsilent unchecked

[Code]
var
  ServerUrlPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ServerUrlPage := CreateInputQueryPage(
    wpSelectDir,
    'QuickHack demo server',
    'Enter the address of the QuickHack demo server.',
    'Use http://127.0.0.1:3000 when the demo server is installed on this PC.'
  );
  ServerUrlPage.Add('Server URL:', False);
  ServerUrlPage.Values[0] := 'http://127.0.0.1:3000';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ServerUrl: String;
  NormalizedUrl: String;
begin
  Result := True;
  if CurPageID <> ServerUrlPage.ID then
    Exit;

  ServerUrl := Trim(ServerUrlPage.Values[0]);
  NormalizedUrl := Lowercase(ServerUrl);
  if (Pos('http://', NormalizedUrl) <> 1) and
    (Pos('https://', NormalizedUrl) <> 1) then
  begin
    MsgBox('Server URL must begin with http:// or https://.', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir: String;
  ConfigPath: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  ConfigDir := ExpandConstant('{localappdata}\QuickHack\{#MutableRootName}');
  ConfigPath := ConfigDir + '\server-url.txt';
  ForceDirectories(ConfigDir);
  if not SaveStringToFile(
    ConfigPath,
    Trim(ServerUrlPage.Values[0]) + #13#10,
    False
  ) then
  begin
    RaiseException('Failed to save the QuickHack demo server URL.');
  end;
end;
