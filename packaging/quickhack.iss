#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif

#ifndef SourceDir
  #define SourceDir "..\release\demo-server"
#endif

#ifndef OutputDir
  #define OutputDir "..\release\distribution\windows\demo-server"
#endif

#ifndef ArtifactAppId
  #define ArtifactAppId "{{5E9CD754-EEDF-47EE-A1EB-8FBCC94AFD82}"
#endif
#ifndef ArtifactKind
  #define ArtifactKind "DEMONSTRATION_SERVER"
#endif
#ifndef ArtifactName
  #define ArtifactName "QuickHack Demo Server"
#endif
#ifndef ArtifactExe
  #define ArtifactExe "QuickHack-Demo-Server.exe"
#endif
#ifndef ArtifactFilePrefix
  #define ArtifactFilePrefix "QuickHack-Demo-Server"
#endif
#ifndef ArtifactGroup
  #define ArtifactGroup "QuickHack Demo"
#endif
#ifndef MutableRootName
  #define MutableRootName "demonstration-server"
#endif
#ifndef PostgresqlServiceName
  #define PostgresqlServiceName "QuickHackDemoPostgreSQL"
#endif
#ifndef OppositePostgresqlServiceName
  #define OppositePostgresqlServiceName "QuickHackOperationalPostgreSQL"
#endif
#ifndef OppositeConsoleServiceName
  #define OppositeConsoleServiceName "QuickHackOperationalServerConsole"
#endif
#ifndef ConsoleServiceName
  #define ConsoleServiceName "QuickHackDemoServerConsole"
#endif
#ifndef OppositeAppId
  #define OppositeAppId "{4AF4F2BB-CB9D-46F7-A8F6-1B585A2BEB17}"
#endif

[Setup]
AppId={#ArtifactAppId}
AppName={#ArtifactName}
AppVersion={#AppVersion}
AppPublisher=QuickHack
DefaultDirName={autopf}\{#ArtifactName}
DefaultGroupName={#ArtifactGroup}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#ArtifactFilePrefix}-Setup-{#AppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#ArtifactExe}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
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

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\packaging\register-console-service.ps1"" -ServiceName ""{#ConsoleServiceName}"" -LauncherPath ""{app}\{#ArtifactExe}"" -DisplayName ""{#ArtifactName} Console"""; Flags: runhidden waituntilterminated
Filename: "{app}\{#ArtifactExe}"; Description: "Open {#ArtifactName} Console"; Flags: postinstall nowait skipifsilent unchecked

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#ConsoleServiceName}"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "delete {#ConsoleServiceName}"; Flags: runhidden waituntilterminated
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""$service=Get-Service -Name '{#PostgresqlServiceName}' -ErrorAction SilentlyContinue; if($service){{if($service.Status -ne 'Stopped'){{Stop-Service -InputObject $service -Force; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60))}; & sc.exe delete {#PostgresqlServiceName} | Out-Null}"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""QuickHack HTTPS Server (Local Subnet)"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""QuickHack Demo Server (Local Subnet)"""; Flags: runhidden waituntilterminated

[UninstallDelete]
; Mutable state under {commonappdata}\QuickHack\{#MutableRootName} is intentionally retained.

[Code]
var
  InitialLeaderPage: TWizardPage;
  InitialLeaderUsernameEdit: TNewEdit;
  InitialLeaderPasswordEdit: TNewEdit;
  InitialLeaderConfirmation: TNewCheckBox;
  InitialLeaderCreated: Boolean;
  InitialLeaderFinalized: Boolean;
  InitialLeaderUsername: String;
  InitialLeaderPassword: String;
  ProvisionResultDir: String;
  ProvisionResultPath: String;

procedure ClearInitialLeaderCredentials;
begin
  InitialLeaderUsername := '';
  InitialLeaderPassword := '';
  if InitialLeaderUsernameEdit <> nil then
    InitialLeaderUsernameEdit.Text := '';
  if InitialLeaderPasswordEdit <> nil then
    InitialLeaderPasswordEdit.Text := '';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  PowerShellPath: String;
  Parameters: String;
begin
  Result := '';
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Parameters :=
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
    '$oppositePackage=Get-Item -LiteralPath ''Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{#OppositeAppId}_is1'' -ErrorAction SilentlyContinue; ' +
    'if($oppositePackage){{Write-Error ''SERVER_FLAVOR_CONFLICT''; exit 30}; ' +
    '$opposite=@(Get-Service -Name ''{#OppositePostgresqlServiceName}'',''{#OppositeConsoleServiceName}'' -ErrorAction SilentlyContinue); ' +
    'if($opposite.Count -gt 0){{Write-Error ''SERVER_FLAVOR_CONFLICT''; exit 31}; ' +
    '$legacy=Get-Service -Name ''QuickHackPostgreSQL'' -ErrorAction SilentlyContinue; ' +
    'if($legacy){{Write-Error ''LEGACY_LAYOUT_DETECTED''; exit 32}; ' +
    '$service=Get-Service -Name ''{#PostgresqlServiceName}'' -ErrorAction SilentlyContinue; ' +
    'if($service -and $service.Status -ne ''Stopped''){' +
    'Stop-Service -InputObject $service -Force; ' +
    '$service.WaitForStatus(''Stopped'',[TimeSpan]::FromSeconds(60))}"';
  if (not Exec(PowerShellPath, Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    Result :=
      'QuickHack PostgreSQL could not be stopped safely for this update. ' +
      'Close QuickHack and retry the installer.';
  end;
end;

procedure DeleteProvisionResult;
begin
  if ProvisionResultPath <> '' then
    DeleteFile(ProvisionResultPath);
  if ProvisionResultDir <> '' then
    DelTree(ProvisionResultDir, True, True, True);
end;

procedure InitialLeaderConfirmationClick(Sender: TObject);
begin
  if Assigned(InitialLeaderPage) and
     (WizardForm.CurPageID = InitialLeaderPage.ID) then
    WizardForm.NextButton.Enabled := InitialLeaderConfirmation.Checked;
end;

procedure InitializeWizard;
var
  IntroLabel: TNewStaticText;
  UsernameLabel: TNewStaticText;
  PasswordLabel: TNewStaticText;
  WarningLabel: TNewStaticText;
begin
  InitialLeaderPage := CreateCustomPage(
    wpInstalling,
    '최초 관리자 계정',
    '이 임시 비밀번호는 이번 설치에서만 표시됩니다.'
  );

  IntroLabel := TNewStaticText.Create(InitialLeaderPage);
  IntroLabel.AutoSize := False;
  IntroLabel.WordWrap := True;
  IntroLabel.Caption :=
    'QuickHack 최초 LEADER 계정이 생성되었습니다. 아래 정보를 안전한 곳에 복사한 뒤 계속하세요.';
  IntroLabel.Width := InitialLeaderPage.SurfaceWidth;
  IntroLabel.Parent := InitialLeaderPage.Surface;
  IntroLabel.AdjustHeight;

  UsernameLabel := TNewStaticText.Create(InitialLeaderPage);
  UsernameLabel.Top := IntroLabel.Top + IntroLabel.Height + ScaleY(16);
  UsernameLabel.Caption := '사용자 이름';
  UsernameLabel.Parent := InitialLeaderPage.Surface;

  InitialLeaderUsernameEdit := TNewEdit.Create(InitialLeaderPage);
  InitialLeaderUsernameEdit.Top := UsernameLabel.Top + UsernameLabel.Height + ScaleY(4);
  InitialLeaderUsernameEdit.Width := InitialLeaderPage.SurfaceWidth;
  InitialLeaderUsernameEdit.ReadOnly := True;
  InitialLeaderUsernameEdit.Parent := InitialLeaderPage.Surface;

  PasswordLabel := TNewStaticText.Create(InitialLeaderPage);
  PasswordLabel.Top := InitialLeaderUsernameEdit.Top + InitialLeaderUsernameEdit.Height + ScaleY(12);
  PasswordLabel.Caption := '임시 비밀번호 (선택 후 Ctrl+C로 복사)';
  PasswordLabel.Parent := InitialLeaderPage.Surface;

  InitialLeaderPasswordEdit := TNewEdit.Create(InitialLeaderPage);
  InitialLeaderPasswordEdit.Top := PasswordLabel.Top + PasswordLabel.Height + ScaleY(4);
  InitialLeaderPasswordEdit.Width := InitialLeaderPage.SurfaceWidth;
  InitialLeaderPasswordEdit.ReadOnly := True;
  InitialLeaderPasswordEdit.Parent := InitialLeaderPage.Surface;

  WarningLabel := TNewStaticText.Create(InitialLeaderPage);
  WarningLabel.AutoSize := False;
  WarningLabel.WordWrap := True;
  WarningLabel.Top := InitialLeaderPasswordEdit.Top + InitialLeaderPasswordEdit.Height + ScaleY(16);
  WarningLabel.Caption :=
    '최초 로그인 직후 새 비밀번호로 변경해야 합니다. 설치 완료 후에는 이 임시 비밀번호를 다시 확인할 수 없습니다.';
  WarningLabel.Width := InitialLeaderPage.SurfaceWidth;
  WarningLabel.Parent := InitialLeaderPage.Surface;
  WarningLabel.AdjustHeight;

  InitialLeaderConfirmation := TNewCheckBox.Create(InitialLeaderPage);
  InitialLeaderConfirmation.Top := WarningLabel.Top + WarningLabel.Height + ScaleY(16);
  InitialLeaderConfirmation.Width := InitialLeaderPage.SurfaceWidth;
  InitialLeaderConfirmation.Caption := '임시 비밀번호를 안전한 곳에 복사했습니다.';
  InitialLeaderConfirmation.Checked := False;
  InitialLeaderConfirmation.OnClick := @InitialLeaderConfirmationClick;
  InitialLeaderConfirmation.Parent := InitialLeaderPage.Surface;
end;

function LoadInitialLeaderResult: Boolean;
var
  Lines: TArrayOfString;
begin
  Result := False;
  if not LoadStringsFromFile(ProvisionResultPath, Lines) then
    Exit;
  if (GetArrayLength(Lines) < 2) or
     (Lines[0] <> 'QUICKHACK_INITIAL_LEADER_RESULT_V1') then
    Exit;

  if Lines[1] = 'status=ALREADY_INITIALIZED' then begin
    InitialLeaderCreated := False;
    Result := True;
    Exit;
  end;

  if (Lines[1] <> 'status=CREATED') or (GetArrayLength(Lines) <> 5) then
    Exit;
  if Pos('userId=', Lines[2]) <> 1 then
    Exit;
  if Lines[3] <> 'username=admin' then
    Exit;
  if Pos('temporaryPassword=', Lines[4]) <> 1 then
    Exit;

  InitialLeaderUsername := Copy(
    Lines[3], Length('username=') + 1, Length(Lines[3])
  );
  InitialLeaderPassword := Copy(
    Lines[4], Length('temporaryPassword=') + 1, Length(Lines[4])
  );
  if (InitialLeaderUsername = '') or (Length(InitialLeaderPassword) <> 32) then begin
    ClearInitialLeaderCredentials;
    Exit;
  end;

  InitialLeaderUsernameEdit.Text := InitialLeaderUsername;
  InitialLeaderPasswordEdit.Text := InitialLeaderPassword;
  InitialLeaderCreated := True;
  Result := True;
end;

function RunFinalizeInstall: Boolean;
var
  ResultCode: Integer;
  PowerShellPath: String;
  ScriptPath: String;
  Parameters: String;
begin
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ScriptPath := ExpandConstant('{app}\packaging\finalize-install.ps1');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath +
    '" -InstallDir "' + ExpandConstant('{app}') + '"';

  Result := Exec(PowerShellPath, Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PowerShellPath: String;
  ScriptPath: String;
  Parameters: String;
  AllowCreate: String;
begin
  if CurStep <> ssPostInstall then
    Exit;

  ProvisionResultDir := ExpandConstant('{tmp}\quickhack-initial-leader-result');
  ProvisionResultPath := AddBackslash(ProvisionResultDir) + 'result.txt';
  if WizardSilent then
    AllowCreate := '0'
  else
    AllowCreate := '1';

  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ScriptPath := ExpandConstant('{app}\packaging\initialize-install.ps1');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath +
    '" -InstallDir "' + ExpandConstant('{app}') +
    '" -DataDir "' + ExpandConstant('{commonappdata}\QuickHack\{#MutableRootName}\data') +
    '" -ArtifactKind "{#ArtifactKind}"' +
    ' -PostgresqlServiceName "{#PostgresqlServiceName}"' +
    ' -ProvisionResultPath "' + ProvisionResultPath +
    '" -AllowInitialLeaderCreation ' + AllowCreate;

  if (not Exec(PowerShellPath, Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    RaiseException(
      'QuickHack database initialization failed. Setup cannot continue. ' +
      'Exit code: ' + IntToStr(ResultCode));
  end;

  if not LoadInitialLeaderResult then begin
    DeleteProvisionResult;
    RaiseException(
      'QuickHack initial account provisioning returned an invalid result. ' +
      'Setup cannot continue.'
    );
  end;
  DeleteProvisionResult;

  if not InitialLeaderCreated then begin
    if not RunFinalizeInstall then
      RaiseException(
        'QuickHack firewall initialization failed. Setup cannot continue.'
      );
    InitialLeaderFinalized := True;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = InitialLeaderPage.ID) and not InitialLeaderCreated;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = InitialLeaderPage.ID then begin
    WizardForm.BackButton.Enabled := False;
    WizardForm.CancelButton.Enabled := False;
    WizardForm.NextButton.Enabled := InitialLeaderConfirmation.Checked;
    WizardForm.ActiveControl := InitialLeaderPasswordEdit;
    InitialLeaderPasswordEdit.SelStart := 0;
    InitialLeaderPasswordEdit.SelLength := Length(InitialLeaderPasswordEdit.Text);
  end;
end;

function BackButtonClick(CurPageID: Integer): Boolean;
begin
  Result := CurPageID <> InitialLeaderPage.ID;
end;

procedure CancelButtonClick(
  CurPageID: Integer;
  var Cancel: Boolean;
  var Confirm: Boolean
);
begin
  if CurPageID = InitialLeaderPage.ID then begin
    Cancel := False;
    Confirm := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID <> InitialLeaderPage.ID then
    Exit;

  if not InitialLeaderConfirmation.Checked then begin
    MsgBox('임시 비밀번호를 복사했는지 확인하세요.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if not InitialLeaderFinalized then begin
    if not RunFinalizeInstall then begin
      MsgBox(
        'QuickHack 방화벽 설정에 실패했습니다. 문제를 해결한 뒤 다시 시도하세요.',
        mbError,
        MB_OK
      );
      Result := False;
      Exit;
    end;
    InitialLeaderFinalized := True;
  end;

  ClearInitialLeaderCredentials;
end;

procedure DeinitializeSetup;
begin
  DeleteProvisionResult;
  ClearInitialLeaderCredentials;
end;
