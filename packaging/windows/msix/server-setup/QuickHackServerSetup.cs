using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

#if QUICKHACK_DEMONSTRATION
[assembly: System.Reflection.AssemblyTitle("QuickHack Demo Server Setup")]
[assembly: System.Reflection.AssemblyProduct("QuickHack Demo Server Setup")]
#else
[assembly: System.Reflection.AssemblyTitle("QuickHack Operational Server Setup")]
[assembly: System.Reflection.AssemblyProduct("QuickHack Operational Server Setup")]
#endif
[assembly: System.Reflection.AssemblyCompany("QuickHack")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

internal static class QuickHackServerSetup
{
    internal const string HandoffProtocol = "QUICKHACK_SERVER_SETUP_HANDOFF_V1";
    internal const string NativeTestGateName = "QUICKHACK_SERVER_SETUP_NATIVE_TEST_GATE";
    internal const string NativeTestGateValue = "PR05_MSIX_GATE";
#if QUICKHACK_DEMONSTRATION
    internal const string ProductName = "QuickHack Demo Server Setup";
    internal const string ArtifactKind = "DEMONSTRATION_SERVER";
    internal const string MutableRootName = "demonstration-server";
#else
    internal const string ProductName = "QuickHack Operational Server Setup";
    internal const string ArtifactKind = "OPERATIONAL_SERVER";
    internal const string MutableRootName = "operational-server";
#endif

    [STAThread]
    private static int Main(string[] args)
    {
        bool nativeTestStdio = args.Length > 0 && String.Equals(
            args[0],
            "--native-test-stdio",
            StringComparison.OrdinalIgnoreCase
        );
        try
        {
            QuickHackSetupDefinition definition = QuickHackSetupDefinition.Create(
                AppDomain.CurrentDomain.BaseDirectory
            );
            if (args.Length == 1 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                definition.ValidatePackageFiles();
                Console.WriteLine(
                    "QUICKHACK_SERVER_SETUP_V1 artifact={0} elevated={1}",
                    ArtifactKind,
                    IsAdministrator() ? "true" : "false"
                );
                return 0;
            }
            if (nativeTestStdio)
            {
                return RunNativeTestStdio(definition, args);
            }
            if (args.Length != 0)
            {
                throw new ArgumentException("QuickHack Server Setup does not accept command-line actions.");
            }
            if (!IsAdministrator())
            {
                throw new InvalidOperationException("QuickHack Server Setup requires administrator elevation.");
            }
            definition.ValidatePackageFiles();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (QuickHackSetupForm form = new QuickHackSetupForm(definition))
            {
                Application.Run(form);
                return form.Completed ? 0 : 2;
            }
        }
        catch (Exception error)
        {
            if (nativeTestStdio)
            {
                Console.Error.WriteLine("errorCode=" + ResolveNativeTestErrorCode(error));
                Console.Error.WriteLine("errorType=" + error.GetType().Name);
                return 1;
            }
            MessageBox.Show(
                error.Message,
                ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static int RunNativeTestStdio(QuickHackSetupDefinition definition, string[] args)
    {
        if (!IsAdministrator())
        {
            throw new InvalidOperationException("QuickHack Server Setup native test requires administrator elevation.");
        }
        if (!String.Equals(
            Environment.GetEnvironmentVariable(NativeTestGateName),
            NativeTestGateValue,
            StringComparison.Ordinal
        ))
        {
            throw new InvalidOperationException("QuickHack Server Setup native test gate is missing.");
        }

        QuickHackSetupHandoff handoff = null;
        try
        {
            if (args.Length == 2 && String.Equals(args[1], "PROVISION", StringComparison.OrdinalIgnoreCase))
            {
                handoff = definition.Provision();
            }
            else if (
                args.Length == 2 &&
                String.Equals(args[1], "REPAIR", StringComparison.OrdinalIgnoreCase)
            )
            {
                handoff = definition.Repair();
            }
            else if (
                args.Length == 2 &&
                String.Equals(args[1], "MIGRATE", StringComparison.OrdinalIgnoreCase)
            )
            {
                handoff = definition.Migrate();
            }
            else if (
                args.Length == 4 &&
                String.Equals(args[1], "ACKNOWLEDGE", StringComparison.OrdinalIgnoreCase)
            )
            {
                int generation;
                if (!Int32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out generation))
                {
                    throw new InvalidDataException("QuickHack Server Setup native test generation is invalid.");
                }
                handoff = definition.Acknowledge(args[2], generation);
            }
            else
            {
                throw new ArgumentException("QuickHack Server Setup native test action is invalid.");
            }
            handoff.WriteToStandardOutput();
            return 0;
        }
        finally
        {
            if (handoff != null) handoff.ClearSecret();
        }
    }

    private static string ResolveNativeTestErrorCode(Exception error)
    {
        Match match = Regex.Match(
            error.Message ?? String.Empty,
            @"\b[A-Z][A-Z0-9_]{2,95}\b",
            RegexOptions.CultureInvariant
        );
        return match.Success ? match.Value : "SERVER_SETUP_NATIVE_TEST_FAILED";
    }

    private static bool IsAdministrator()
    {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        WindowsPrincipal principal = new WindowsPrincipal(identity);
        return principal.IsInRole(WindowsBuiltInRole.Administrator);
    }
}

internal sealed class QuickHackSetupDefinition
{
    private static readonly Regex StableCode = new Regex(
        "^[A-Z][A-Z0-9_]{2,95}$",
        RegexOptions.CultureInvariant
    );
    private readonly string packageRoot;
    private readonly string mutableRoot;

    private QuickHackSetupDefinition(string root)
    {
        packageRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        mutableRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "QuickHack",
            QuickHackServerSetup.MutableRootName
        );
    }

    internal static QuickHackSetupDefinition Create(string root)
    {
        return new QuickHackSetupDefinition(Path.GetFullPath(root));
    }

    internal void ValidatePackageFiles()
    {
        string manifest = RequiredFile("quickhack-package.json");
        string manifestText = File.ReadAllText(manifest, Encoding.UTF8);
        string expectedIdentity = "\"artifactKind\": \"" + QuickHackServerSetup.ArtifactKind + "\"";
        if (manifestText.IndexOf(expectedIdentity, StringComparison.Ordinal) < 0)
        {
            throw new InvalidDataException("The QuickHack package manifest does not match Server Setup.");
        }
        RequiredFile("runtime", "node", "node.exe");
        RequiredFile("tools", "server-provisioning-cli.mjs");
        RequiredFile("tools", "server-provisioning-core.mjs");
        RequiredFile("tools", "server-provisioning-contract.mjs");
        RequiredFile("tools", "windows-legacy-msix-migration.mjs");
    }

    internal QuickHackSetupHandoff Provision()
    {
        return RunProvisioner(new[] {
            "--provision",
            "--handoff-stdio",
        });
    }

    internal QuickHackSetupHandoff Migrate()
    {
        return RunProvisioner(new[] {
            "--migrate",
            "--handoff-stdio",
        });
    }

    internal QuickHackSetupHandoff Repair()
    {
        return RunProvisioner(new[] {
            "--repair",
            "--handoff-stdio",
        });
    }

    internal QuickHackSetupHandoff Acknowledge(string transactionId, int generation)
    {
        Guid parsedTransactionId;
        if (!Guid.TryParse(transactionId, out parsedTransactionId))
        {
            throw new InvalidDataException("The pending Setup transaction id is invalid.");
        }
        if (generation < 1)
        {
            throw new InvalidDataException("The pending Setup generation is invalid.");
        }
        return RunProvisioner(new[] {
            "--acknowledge",
            "--transaction-id", transactionId,
            "--generation", generation.ToString(CultureInfo.InvariantCulture),
        });
    }

    internal void AppendAuditEvent(string code)
    {
        if (!StableCode.IsMatch(code ?? String.Empty))
        {
            throw new InvalidDataException("Setup audit events require a stable code.");
        }
        string logDirectory = Path.Combine(mutableRoot, "logs");
        Directory.CreateDirectory(logDirectory);
        File.AppendAllText(
            Path.Combine(logDirectory, "server-setup.log"),
            DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture) + " code=" + code + Environment.NewLine,
            new UTF8Encoding(false)
        );
    }

    private QuickHackSetupHandoff RunProvisioner(string[] actionArguments)
    {
        ValidatePackageFiles();
        string node = RequiredFile("runtime", "node", "node.exe");
        string provisioner = RequiredFile("tools", "server-provisioning-cli.mjs");
        string manifest = RequiredFile("quickhack-package.json");
        List<string> arguments = new List<string>();
        arguments.Add(Quote(provisioner));
        arguments.AddRange(actionArguments);
        arguments.Add("--artifact-kind");
        arguments.Add(QuickHackServerSetup.ArtifactKind);
        arguments.Add("--package-root");
        arguments.Add(Quote(packageRoot));
        arguments.Add("--program-data");
        arguments.Add(Quote(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData)));

        StringDictionary environment = QuickHackDesktopAppProcess.InheritCurrentEnvironment();
        ConfigureEnvironment(environment, node, manifest);
        string errorCode = "PROVISIONING_STEP_FAILED";
        QuickHackSetupHandoff handoff = new QuickHackSetupHandoff();
        int exitCode = QuickHackDesktopAppProcess.Run(
            node,
            String.Join(" ", arguments.ToArray()),
            packageRoot,
            environment,
            delegate(string line)
            {
                handoff.Accept(line);
            },
            delegate(string errorLine)
            {
                if (errorLine.StartsWith("errorCode=", StringComparison.Ordinal))
                {
                    string candidate = errorLine.Substring("errorCode=".Length);
                    if (StableCode.IsMatch(candidate)) errorCode = candidate;
                }
            }
        );
        if (exitCode != 0)
        {
            AppendAuditEvent(errorCode);
            throw new InvalidOperationException(
                "QuickHack Server Setup stopped with " + errorCode + ". Check server-setup.log."
            );
        }
        handoff.Validate();
        AppendAuditEvent(handoff.Status == "READY" ? "PROVISIONING_READY" : "INITIAL_LEADER_ACK_REQUIRED");
        return handoff;
    }

    private static void ConfigureEnvironment(StringDictionary environment, string node, string manifest)
    {
        foreach (string name in new[] {
            "NODE_OPTIONS",
            "NODE_PATH",
            "NODE_EXTRA_CA_CERTS",
            "DATABASE_URL",
            "QUICKHACK_PACKAGE_MANIFEST",
            "QUICKHACK_ARTIFACT_KIND",
            "QUICKHACK_PACKAGE_FLAVOR",
            "QUICKHACK_WINDOWS_SECRET_SCOPE"
        })
        {
            environment.Remove(name);
        }
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows";
        environment["PATH"] = String.Join(";", new[] {
            Path.GetDirectoryName(node),
            Path.Combine(systemRoot, "System32"),
            systemRoot,
            Path.Combine(systemRoot, "System32", "Wbem"),
            Path.Combine(systemRoot, "System32", "WindowsPowerShell", "v1.0")
        });
        environment["SystemRoot"] = systemRoot;
        environment["WINDIR"] = systemRoot;
        environment["ProgramData"] = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        environment["QUICKHACK_PACKAGE_MANIFEST"] = manifest;
        environment["QUICKHACK_WINDOWS_SECRET_SCOPE"] = "LOCAL_MACHINE";
    }

    private string RequiredFile(params string[] parts)
    {
        string result = packageRoot;
        foreach (string part in parts) result = Path.Combine(result, part);
        if (!File.Exists(result))
        {
            throw new FileNotFoundException("Required QuickHack Server Setup file was not found.", result);
        }
        return result;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}

internal sealed class QuickHackSetupHandoff
{
    private static readonly Regex PasswordPattern = new Regex(
        "^[A-Za-z0-9_-]{32,128}$",
        RegexOptions.CultureInvariant
    );
    private bool protocolObserved;

    internal string Status { get; private set; }
    internal string TransactionId { get; private set; }
    internal int UserId { get; private set; }
    internal int Generation { get; private set; }
    internal string Username { get; private set; }
    internal string TemporaryPassword { get; private set; }

    internal void Accept(string line)
    {
        if (!protocolObserved)
        {
            if (!String.Equals(line, QuickHackServerSetup.HandoffProtocol, StringComparison.Ordinal))
            {
                throw new InvalidDataException("Server Setup received an invalid handoff protocol.");
            }
            protocolObserved = true;
            return;
        }
        int separator = line.IndexOf('=');
        if (separator < 1)
        {
            throw new InvalidDataException("Server Setup received an invalid handoff frame.");
        }
        string name = line.Substring(0, separator);
        string value = line.Substring(separator + 1);
        switch (name)
        {
            case "status": Status = value; break;
            case "transactionId": TransactionId = value; break;
            case "userId": UserId = Int32.Parse(value, CultureInfo.InvariantCulture); break;
            case "generation": Generation = Int32.Parse(value, CultureInfo.InvariantCulture); break;
            case "username": Username = value; break;
            case "temporaryPassword": TemporaryPassword = value; break;
            default: throw new InvalidDataException("Server Setup received an unsupported handoff field.");
        }
    }

    internal void Validate()
    {
        Guid parsedTransactionId;
        if (!protocolObserved || !Guid.TryParse(TransactionId, out parsedTransactionId))
        {
            throw new InvalidDataException("Server Setup handoff identity is invalid.");
        }
        if (Status == "READY") return;
        if (
            Status != "INITIAL_LEADER_PENDING_ACK" ||
            UserId < 1 ||
            Generation < 1 ||
            Username != "admin" ||
            !PasswordPattern.IsMatch(TemporaryPassword ?? String.Empty)
        )
        {
            throw new InvalidDataException("Server Setup credential handoff is invalid.");
        }
    }

    internal void ClearSecret()
    {
        TemporaryPassword = null;
    }

    internal void WriteToStandardOutput()
    {
        Validate();
        Console.WriteLine(QuickHackServerSetup.HandoffProtocol);
        Console.WriteLine("status=" + Status);
        Console.WriteLine("transactionId=" + TransactionId);
        if (Status == "INITIAL_LEADER_PENDING_ACK")
        {
            Console.WriteLine("userId=" + UserId.ToString(CultureInfo.InvariantCulture));
            Console.WriteLine("generation=" + Generation.ToString(CultureInfo.InvariantCulture));
            Console.WriteLine("username=" + Username);
            Console.WriteLine("temporaryPassword=" + TemporaryPassword);
        }
        Console.Out.Flush();
    }
}

internal sealed class QuickHackSetupForm : Form
{
    private readonly QuickHackSetupDefinition definition;
    private readonly Label statusLabel;
    private readonly TextBox usernameBox;
    private readonly TextBox passwordBox;
    private readonly Button acknowledgeButton;
    private readonly Button migrationButton;
    private readonly Button repairButton;
    private QuickHackSetupHandoff pending;

    internal bool Completed { get; private set; }

    internal QuickHackSetupForm(QuickHackSetupDefinition setupDefinition)
    {
        definition = setupDefinition;
        Text = QuickHackServerSetup.ProductName;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 280);
        MinimumSize = new Size(620, 280);
        MaximizeBox = false;

        statusLabel = new Label {
            AutoSize = false,
            Location = new Point(24, 22),
            Size = new Size(570, 54),
            Text = "서버 상태를 확인하고 있습니다. 창을 닫아도 다음 실행에서 안전하게 재개됩니다."
        };
        usernameBox = new TextBox {
            Location = new Point(150, 98),
            Size = new Size(420, 24),
            ReadOnly = true
        };
        passwordBox = new TextBox {
            Location = new Point(150, 136),
            Size = new Size(420, 24),
            ReadOnly = true
        };
        acknowledgeButton = new Button {
            Location = new Point(350, 190),
            Size = new Size(220, 38),
            Text = "비밀번호 복사 후 확인",
            Enabled = false
        };
        migrationButton = new Button {
            Location = new Point(24, 190),
            Size = new Size(240, 38),
            Text = "기존 Inno 설치를 MSIX로 이전",
            Enabled = true
        };
        repairButton = new Button {
            Location = new Point(274, 190),
            Size = new Size(120, 38),
            Text = "제품 복구",
            Enabled = false
        };
        acknowledgeButton.Location = new Point(404, 190);
        acknowledgeButton.Size = new Size(166, 38);
        acknowledgeButton.Click += AcknowledgeClicked;
        migrationButton.Click += MigrationClicked;
        repairButton.Click += RepairClicked;
        Controls.Add(statusLabel);
        Controls.Add(new Label { Location = new Point(24, 101), AutoSize = true, Text = "초기 관리자 계정" });
        Controls.Add(usernameBox);
        Controls.Add(new Label { Location = new Point(24, 139), AutoSize = true, Text = "임시 비밀번호" });
        Controls.Add(passwordBox);
        Controls.Add(acknowledgeButton);
        Controls.Add(migrationButton);
        Controls.Add(repairButton);
        Shown += delegate { BeginProvisioning(); };
        FormClosing += delegate {
            passwordBox.Clear();
            if (pending != null) pending.ClearSecret();
        };
    }

    private void BeginProvisioning()
    {
        migrationButton.Enabled = false;
        repairButton.Enabled = false;
        SetBusy(true, "서버 데이터베이스와 서비스를 준비하고 있습니다...");
        BackgroundWorker worker = new BackgroundWorker();
        worker.DoWork += delegate(object sender, DoWorkEventArgs eventArgs) {
            eventArgs.Result = definition.Provision();
        };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs eventArgs) {
            if (eventArgs.Error != null)
            {
                migrationButton.Enabled = true;
                repairButton.Enabled = true;
                SetBusy(false, eventArgs.Error.Message);
                return;
            }
            ShowHandoff((QuickHackSetupHandoff)eventArgs.Result);
        };
        worker.RunWorkerAsync();
    }

    private void ShowHandoff(QuickHackSetupHandoff handoff)
    {
        if (handoff.Status == "READY")
        {
            Completed = true;
            SetBusy(false, "QuickHack Demo Server 준비가 완료되었습니다. 이 창을 닫아도 됩니다.");
            acknowledgeButton.Enabled = false;
            migrationButton.Enabled = false;
            repairButton.Enabled = false;
            return;
        }
        pending = handoff;
        usernameBox.Text = handoff.Username;
        passwordBox.Text = handoff.TemporaryPassword;
        statusLabel.Text = "아래 임시 비밀번호를 안전한 곳에 저장한 뒤 확인하십시오. 확인 전 종료하면 기존 비밀번호는 폐기되고 다음 실행에서 재발급됩니다.";
        acknowledgeButton.Enabled = true;
        migrationButton.Enabled = false;
        repairButton.Enabled = false;
    }

    private void AcknowledgeClicked(object sender, EventArgs eventArgs)
    {
        if (pending == null) return;
        Clipboard.SetText(pending.TemporaryPassword);
        acknowledgeButton.Enabled = false;
        SetBusy(true, "초기 관리자 비밀번호 확인을 기록하고 서비스를 시작하고 있습니다...");
        BackgroundWorker worker = new BackgroundWorker();
        worker.DoWork += delegate(object workerSender, DoWorkEventArgs workerArgs) {
            workerArgs.Result = definition.Acknowledge(pending.TransactionId, pending.Generation);
        };
        worker.RunWorkerCompleted += delegate(object workerSender, RunWorkerCompletedEventArgs workerArgs) {
            if (workerArgs.Error != null)
            {
                acknowledgeButton.Enabled = true;
                SetBusy(false, workerArgs.Error.Message);
                return;
            }
            passwordBox.Clear();
            pending.ClearSecret();
            pending = null;
            ShowHandoff((QuickHackSetupHandoff)workerArgs.Result);
        };
        worker.RunWorkerAsync();
    }

    private void MigrationClicked(object sender, EventArgs eventArgs)
    {
        migrationButton.Enabled = false;
        repairButton.Enabled = false;
        SetBusy(true, "기존 QuickHack 설치와 데이터를 확인하고 MSIX로 이전하고 있습니다...");
        BackgroundWorker worker = new BackgroundWorker();
        worker.DoWork += delegate(object workerSender, DoWorkEventArgs workerArgs) {
            workerArgs.Result = definition.Migrate();
        };
        worker.RunWorkerCompleted += delegate(object workerSender, RunWorkerCompletedEventArgs workerArgs) {
            if (workerArgs.Error != null)
            {
                migrationButton.Enabled = true;
                repairButton.Enabled = true;
                SetBusy(false, workerArgs.Error.Message);
                return;
            }
            ShowHandoff((QuickHackSetupHandoff)workerArgs.Result);
        };
        worker.RunWorkerAsync();
    }

    private void RepairClicked(object sender, EventArgs eventArgs)
    {
        migrationButton.Enabled = false;
        repairButton.Enabled = false;
        SetBusy(true, "패키지와 서버 상태를 진단하고 비파괴 복구를 수행하고 있습니다...");
        BackgroundWorker worker = new BackgroundWorker();
        worker.DoWork += delegate(object workerSender, DoWorkEventArgs workerArgs) {
            workerArgs.Result = definition.Repair();
        };
        worker.RunWorkerCompleted += delegate(object workerSender, RunWorkerCompletedEventArgs workerArgs) {
            if (workerArgs.Error != null)
            {
                migrationButton.Enabled = true;
                repairButton.Enabled = true;
                SetBusy(false, workerArgs.Error.Message);
                return;
            }
            ShowHandoff((QuickHackSetupHandoff)workerArgs.Result);
        };
        worker.RunWorkerAsync();
    }

    private void SetBusy(bool busy, string status)
    {
        UseWaitCursor = busy;
        statusLabel.Text = status;
    }
}
