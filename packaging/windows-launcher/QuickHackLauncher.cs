using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Windows.Forms;

#if QUICKHACK_CLIENT && QUICKHACK_DEMONSTRATION
[assembly: AssemblyTitle("QuickHack Demo Client")]
[assembly: AssemblyProduct("QuickHack Demo Client")]
#elif QUICKHACK_SERVER && QUICKHACK_DEMONSTRATION
[assembly: AssemblyTitle("QuickHack Demo Server")]
[assembly: AssemblyProduct("QuickHack Demo Server")]
#elif QUICKHACK_CLIENT && QUICKHACK_OPERATIONAL
[assembly: AssemblyTitle("QuickHack Operational Client")]
[assembly: AssemblyProduct("QuickHack Operational Client")]
#else
[assembly: AssemblyTitle("QuickHack Operational Server")]
[assembly: AssemblyProduct("QuickHack Operational Server")]
#endif
[assembly: AssemblyCompany("QuickHack")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class QuickHackLauncher
{
#if QUICKHACK_CLIENT && QUICKHACK_DEMONSTRATION
    private const string ProductName = "QuickHack Demo Client";
    private const string ArtifactKind = "DEMONSTRATION_CLIENT";
    private const string MutableRootName = "demonstration-client";
    private const int ClientPort = 3001;
#elif QUICKHACK_CLIENT && QUICKHACK_OPERATIONAL
    private const string ProductName = "QuickHack Operational Client";
    private const string ArtifactKind = "OPERATIONAL_CLIENT";
    private const string MutableRootName = "operational-client";
    private const int ClientPort = 3002;
#elif QUICKHACK_SERVER && QUICKHACK_DEMONSTRATION
    private const string ProductName = "QuickHack Demo Server";
    private const string ArtifactKind = "DEMONSTRATION_SERVER";
    private const string MutableRootName = "demonstration-server";
    private const string PackageFlavor = "DEMONSTRATION";
    private const string ServerConsoleEntry = "server-console-demonstration.mjs";
    private const string ServerServiceName = "QuickHackDemoServerConsole";
#else
    private const string ProductName = "QuickHack Operational Server";
    private const string ArtifactKind = "OPERATIONAL_SERVER";
    private const string MutableRootName = "operational-server";
    private const string PackageFlavor = "OPERATIONAL";
    private const string ServerConsoleEntry = "server-console-operational.mjs";
    private const string ServerServiceName = "QuickHackOperationalServerConsole";
#endif

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );

            if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                ValidatePackage(root);
                return 0;
            }

#if QUICKHACK_SERVER
            if (args.Length > 0 && String.Equals(args[0], "--windows-service", StringComparison.OrdinalIgnoreCase))
            {
                ServiceBase.Run(new QuickHackServerService(root));
                return 0;
            }
#endif

#if QUICKHACK_CLIENT
            return StartClient(root, args);
#else
            return StartServer(root);
#endif
        }
        catch (Exception error)
        {
            MessageBox.Show(
                error.Message,
                ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }
    }

    private static void ValidatePackage(string root)
    {
        RequiredFile(root, "runtime", "node", "node.exe");
        string manifest = RequiredFile(root, "quickhack-package.json");
        string manifestText = File.ReadAllText(manifest, Encoding.UTF8);
        string expectedIdentity = "\"artifactKind\": \"" + ArtifactKind + "\"";
        if (manifestText.IndexOf(expectedIdentity, StringComparison.Ordinal) < 0)
        {
            throw new InvalidDataException("The QuickHack package manifest does not match this launcher.");
        }

#if QUICKHACK_CLIENT
        RequiredFile(root, "tools", "client-runtime-launcher.mjs");
        RequiredFile(root, "tools", "client-print-spool-core.mjs");
        RequiredFile(root, "client", "server.js");
#else
        RequiredFile(root, "tools", ServerConsoleEntry);
        RequiredFile(root, "quickhack_server", "observability", "trace-retention-policy.mjs");
        RequiredFile(root, "server", "server.js");
#if QUICKHACK_DEMONSTRATION
        RequiredFile(root, "mock_server", "coupang-mock-server.mjs");
#endif
#endif
    }

    private static string RequiredFile(string root, params string[] parts)
    {
        string path = root;

        foreach (string part in parts)
        {
            path = Path.Combine(path, part);
        }

        if (!File.Exists(path))
        {
            throw new FileNotFoundException("Required QuickHack runtime file was not found.", path);
        }

        return path;
    }

#if QUICKHACK_CLIENT
    private static int StartClient(string root, string[] args)
    {
        ValidatePackage(root);
        string node = RequiredFile(root, "runtime", "node", "node.exe");
        string launcher = RequiredFile(root, "tools", "client-runtime-launcher.mjs");
        string command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "start";

        if (command != "start" && command != "restart" && command != "stop" && command != "status")
        {
            throw new ArgumentException("Supported commands: start, restart, stop, status");
        }

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = node;
        string manifest = RequiredFile(root, "quickhack-package.json");
        startInfo.Arguments = Quote(launcher) + " " + command +
            " --package-manifest " + Quote(manifest);
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;

        string standardOutput;
        string standardError;
        int exitCode;

        using (Process process = Process.Start(startInfo))
        {
            standardOutput = process.StandardOutput.ReadToEnd();
            standardError = process.StandardError.ReadToEnd();
            process.WaitForExit();
            exitCode = process.ExitCode;
        }

        if (exitCode != 0)
        {
            string detail = FirstNonEmpty(standardError, standardOutput, "QuickHack client failed to start.");
            throw new InvalidOperationException(detail.Trim());
        }

        if (command == "start" || command == "restart")
        {
            OpenClientWindow(ClientUrl());
        }
        else
        {
            MessageBox.Show(
                FirstNonEmpty(standardOutput, standardError, "Command completed."),
                ProductName,
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        return 0;
    }

    private static string ClientUrl()
    {
        return "http://127.0.0.1:" + ClientPort;
    }

    private static void OpenClientWindow(string url)
    {
        string edge = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe"
        );
        string chrome = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "Google",
            "Chrome",
            "Application",
            "chrome.exe"
        );
        string browser = File.Exists(edge) ? edge : (File.Exists(chrome) ? chrome : null);

        if (browser != null)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = browser,
                Arguments = "--app=" + url + " --start-maximized",
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(browser)
            });
            return;
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true
        });
    }
#else
    private static int StartServer(string root)
    {
        ValidatePackage(root);
        using (ServiceController service = new ServiceController(ServerServiceName))
        {
            try
            {
                if (service.Status == ServiceControllerStatus.Stopped)
                {
                    service.Start();
                    service.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(60));
                }
                Process.Start(new ProcessStartInfo
                {
                    FileName = "http://127.0.0.1:2999",
                    UseShellExecute = true
                });
                return 0;
            }
            catch (InvalidOperationException)
            {
                // Debug staging can run without an installed SCM registration.
            }
        }
        StartServerProcess(root, false);
        return 0;
    }

    private static Process StartServerProcess(string root, bool systemService)
    {
        ValidatePackage(root);
        string node = RequiredFile(root, "runtime", "node", "node.exe");
        string consoleScript = RequiredFile(root, "tools", ServerConsoleEntry);
        string manifest = RequiredFile(root, "quickhack-package.json");
        string commonData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        string mutableRoot = Path.Combine(commonData, "QuickHack", MutableRootName);
        string dataDir = Path.Combine(mutableRoot, "data");
        string runtimeConfig = EnsureServerRuntimeConfig(mutableRoot, dataDir);

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = node;
        startInfo.Arguments = Quote(consoleScript) +
            " --runtime-config " + Quote(runtimeConfig) +
            " --package-manifest " + Quote(manifest) +
            (systemService ? " --system-service --no-open" : "");
        startInfo.WorkingDirectory = root;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" +
            (Environment.GetEnvironmentVariable("PATH") ?? String.Empty);

        return Process.Start(startInfo);
    }

    private sealed class QuickHackServerService : ServiceBase
    {
        private readonly string root;
        private Process consoleProcess;

        internal QuickHackServerService(string packageRoot)
        {
            root = packageRoot;
            ServiceName = ServerServiceName;
            CanStop = true;
            CanShutdown = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            consoleProcess = StartServerProcess(root, true);
        }

        protected override void OnStop()
        {
            StopConsoleProcess();
        }

        protected override void OnShutdown()
        {
            StopConsoleProcess();
            base.OnShutdown();
        }

        private void StopConsoleProcess()
        {
            if (consoleProcess == null || consoleProcess.HasExited) return;
            consoleProcess.Kill();
            consoleProcess.WaitForExit(15000);
            consoleProcess.Dispose();
            consoleProcess = null;
        }
    }

    private static string EnsureServerRuntimeConfig(string mutableRoot, string dataDir)
    {
        string configDirectory = Path.Combine(mutableRoot, "config");
        string configPath = Path.Combine(configDirectory, "server-runtime.json");
        SecureDirectory(configDirectory);

        if (File.Exists(configPath))
        {
            return configPath;
        }

        Directory.CreateDirectory(dataDir);
        string mockDatabaseFields = PackageFlavor == "DEMONSTRATION"
            ? ",\r\n" +
              "    \"coupangMockName\": \"quickhack_mock_coupang\",\r\n" +
              "    \"coupangMockUser\": \"quickhack_mock_coupang\",\r\n" +
              "    \"logenMockName\": \"quickhack_mock_logen\",\r\n" +
              "    \"logenMockUser\": \"quickhack_mock_logen\"\r\n"
            : "\r\n";
        string json = "{\r\n" +
            "  \"schemaVersion\": 3,\r\n" +
            "  \"packageFlavor\": \"" + PackageFlavor + "\",\r\n" +
            "  \"environment\": \"development\",\r\n" +
            "  \"coupangWriteApiEnabled\": true,\r\n" +
            "  \"logenWriteApiEnabled\": true,\r\n" +
            "  \"dataDirectory\": " + JsonString(dataDir) + ",\r\n" +
            "  \"backupRetentionCount\": 30,\r\n" +
            "  \"database\": {\r\n" +
            "    \"host\": \"127.0.0.1\",\r\n" +
            "    \"port\": 5432,\r\n" +
            "    \"name\": \"quickhack\",\r\n" +
            "    \"runtimeUser\": \"quickhack_runtime\",\r\n" +
            "    \"migratorUser\": \"quickhack_migrator\"" + mockDatabaseFields +
            "  }\r\n" +
            "}\r\n";
        string temporaryPath = Path.Combine(
            configDirectory,
            ".server-runtime.json." + Process.GetCurrentProcess().Id + ".tmp"
        );

        File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
        try
        {
            File.Move(temporaryPath, configPath);
        }
        catch (IOException)
        {
            if (!File.Exists(configPath))
            {
                throw;
            }
            File.Delete(temporaryPath);
        }
        return configPath;
    }

    private static void SecureDirectory(string directoryPath)
    {
        Directory.CreateDirectory(directoryPath);
        DirectorySecurity security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
        SecurityIdentifier administrators = new SecurityIdentifier("S-1-5-32-544");

        foreach (SecurityIdentifier identity in new[] { current, system, administrators })
        {
            security.AddAccessRule(new FileSystemAccessRule(
                identity,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow
            ));
        }

        Directory.SetAccessControl(directoryPath, security);
    }

    private static string JsonString(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
#endif

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FirstNonEmpty(params string[] values)
    {
        foreach (string value in values)
        {
            if (!String.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return String.Empty;
    }
}
