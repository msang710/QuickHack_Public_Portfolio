using System;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

#if QUICKHACK_DEMONSTRATION && QUICKHACK_POSTGRESQL
[assembly: System.Reflection.AssemblyTitle("QuickHack Demo PostgreSQL Packaged Service Host")]
#elif QUICKHACK_DEMONSTRATION && QUICKHACK_CONSOLE
[assembly: System.Reflection.AssemblyTitle("QuickHack Demo Console Packaged Service Host")]
#elif QUICKHACK_OPERATIONAL && QUICKHACK_POSTGRESQL
[assembly: System.Reflection.AssemblyTitle("QuickHack Operational PostgreSQL Packaged Service Host")]
#else
[assembly: System.Reflection.AssemblyTitle("QuickHack Operational Console Packaged Service Host")]
#endif
[assembly: System.Reflection.AssemblyCompany("QuickHack")]
[assembly: System.Reflection.AssemblyProduct("QuickHack Packaged Service Host")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

internal static class QuickHackPackagedServiceHost
{
#if QUICKHACK_DEMONSTRATION
#if QUICKHACK_PREVIEW
    internal const string MutableRootName = "msix-preview-demonstration-server";
#else
    internal const string MutableRootName = "demonstration-server";
#endif
    internal const string PackageFlavor = "DEMONSTRATION";
    internal const string PostgresqlMajorVersion = "18";
#if QUICKHACK_POSTGRESQL
#if QUICKHACK_PREVIEW
    internal const string ServiceName = "QuickHackPreviewDemoPostgreSQL";
#else
    internal const string ServiceName = "QuickHackDemoPostgreSQL";
#endif
#else
#if QUICKHACK_PREVIEW
    internal const string ServiceName = "QuickHackPreviewDemoServerConsole";
#else
    internal const string ServiceName = "QuickHackDemoServerConsole";
#endif
    internal const string ConsoleEntrypoint = "server-console-demonstration.mjs";
#endif
#else
    internal const string MutableRootName = "operational-server";
    internal const string PackageFlavor = "OPERATIONAL";
    internal const string PostgresqlMajorVersion = "18";
#if QUICKHACK_POSTGRESQL
    internal const string ServiceName = "QuickHackOperationalPostgreSQL";
#else
    internal const string ServiceName = "QuickHackOperationalServerConsole";
    internal const string ConsoleEntrypoint = "server-console-operational.mjs";
#endif
#endif

    private static int Main(string[] args)
    {
        string servicesDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );
        DirectoryInfo packageDirectory = Directory.GetParent(servicesDirectory);
        if (packageDirectory == null)
        {
            throw new InvalidOperationException("QuickHack packaged service root could not be resolved.");
        }
        string packageRoot = packageDirectory.FullName;
        if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
        {
            QuickHackServiceDefinition definition = QuickHackServiceDefinition.Create(packageRoot);
            definition.ValidatePackageFiles();
            Console.WriteLine(
                "QUICKHACK_PACKAGED_SERVICE_HOST_V1 service={0} state={1} child={2}",
                ServiceName,
                definition.IsProvisioned ? "READY" : "PROVISIONING_REQUIRED",
                definition.ChildExecutable
            );
            return 0;
        }
        ServiceBase.Run(new QuickHackWindowsService(packageRoot));
        return 0;
    }
}

internal sealed class QuickHackServiceDefinition
{
    private readonly string packageRoot;
    private readonly string mutableRoot;
    private readonly bool preview;

    private QuickHackServiceDefinition(string resolvedPackageRoot)
    {
        packageRoot = resolvedPackageRoot;
        mutableRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "QuickHack",
            QuickHackPackagedServiceHost.MutableRootName
        );
        preview = File.Exists(Path.Combine(packageRoot, "Services", "quickhack-msix-service-preview.txt"));
    }

    internal static QuickHackServiceDefinition Create(string packageRoot)
    {
        string resolved = Path.GetFullPath(packageRoot).TrimEnd(
            Path.DirectorySeparatorChar,
            Path.AltDirectorySeparatorChar
        );
        return new QuickHackServiceDefinition(resolved);
    }

    internal bool IsProvisioned
    {
        get
        {
            if (preview) return true;
#if QUICKHACK_POSTGRESQL
            return File.Exists(Path.Combine(mutableRoot, "provisioning", "POSTGRES_CLUSTER_READY"));
#else
            return File.Exists(Path.Combine(mutableRoot, "provisioning", "SERVICES_READY"));
#endif
        }
    }

    internal string ReadinessMarkerName
    {
        get
        {
#if QUICKHACK_POSTGRESQL
            return "POSTGRES_CLUSTER_READY";
#else
            return "SERVICES_READY";
#endif
        }
    }

    internal string MutableRoot
    {
        get { return mutableRoot; }
    }

    internal string ChildExecutable
    {
        get
        {
#if QUICKHACK_POSTGRESQL
            return Path.Combine(packageRoot, "runtime", "postgresql", "bin", "postgres.exe");
#else
            return Path.Combine(packageRoot, "runtime", "node", "node.exe");
#endif
        }
    }

    internal string ChildArguments
    {
        get
        {
#if QUICKHACK_POSTGRESQL
            if (preview) return "--quickhack-msix-preview";
            return "-D " + Quote(Path.Combine(
                mutableRoot,
                "data",
                "postgresql",
                QuickHackPackagedServiceHost.PostgresqlMajorVersion,
                "data"
            ));
#else
            if (preview)
            {
                return Quote(Path.Combine(packageRoot, "Services", "quickhack-preview-console-child.mjs"));
            }
            return Quote(Path.Combine(packageRoot, "tools", QuickHackPackagedServiceHost.ConsoleEntrypoint)) +
                " --runtime-config " + Quote(Path.Combine(mutableRoot, "config", "server-runtime.json")) +
                " --package-manifest " + Quote(Path.Combine(packageRoot, "quickhack-package.json")) +
                " --system-service --no-open";
#endif
        }
    }

    internal string WorkingDirectory
    {
        get { return packageRoot; }
    }

    internal void ValidatePackageFiles()
    {
        RequiredFile(ChildExecutable);
#if QUICKHACK_CONSOLE
        if (preview)
        {
            RequiredFile(Path.Combine(packageRoot, "Services", "quickhack-preview-console-child.mjs"));
        }
        else
        {
            RequiredFile(Path.Combine(packageRoot, "tools", QuickHackPackagedServiceHost.ConsoleEntrypoint));
            RequiredFile(Path.Combine(packageRoot, "quickhack-package.json"));
        }
#endif
    }

    internal ProcessStartInfo CreateStartInfo()
    {
        ValidatePackageFiles();
        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = ChildExecutable;
        startInfo.Arguments = ChildArguments;
        startInfo.WorkingDirectory = WorkingDirectory;
        startInfo.UseShellExecute = false;
        startInfo.CreateNoWindow = true;
        startInfo.WindowStyle = ProcessWindowStyle.Hidden;
        startInfo.RedirectStandardInput = false;
        startInfo.RedirectStandardOutput = false;
        startInfo.RedirectStandardError = false;
        ReplaceEnvironment(startInfo.EnvironmentVariables, Path.GetDirectoryName(ChildExecutable));
        return startInfo;
    }

    private static void ReplaceEnvironment(StringDictionary environment, string executableDirectory)
    {
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? "C:\\Windows";
        string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        environment.Clear();
        environment["PATH"] = executableDirectory;
        environment["SystemRoot"] = systemRoot;
        environment["WINDIR"] = systemRoot;
        environment["ProgramData"] = programData;
        environment["QUICKHACK_PACKAGE_FLAVOR"] = QuickHackPackagedServiceHost.PackageFlavor;
        environment["QUICKHACK_WINDOWS_SECRET_SCOPE"] = "LOCAL_MACHINE";
    }

    private static void RequiredFile(string filename)
    {
        if (!File.Exists(filename))
        {
            throw new FileNotFoundException("Required QuickHack packaged service file was not found.", filename);
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}

internal sealed class QuickHackWindowsService : ServiceBase
{
    private readonly object synchronization = new object();
    private readonly QuickHackServiceDefinition definition;
    private Process child;
    private QuickHackProcessJob processJob;
    private bool stopping;

    internal QuickHackWindowsService(string packageRoot)
    {
        definition = QuickHackServiceDefinition.Create(packageRoot);
        ServiceName = QuickHackPackagedServiceHost.ServiceName;
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        if (!definition.IsProvisioned)
        {
            TryLogCode("PROVISIONING_REQUIRED", EventLogEntryType.Information);
            return;
        }
        Process started = Process.Start(definition.CreateStartInfo());
        if (started == null)
        {
            throw new InvalidOperationException("QuickHack packaged service child did not start.");
        }
        QuickHackProcessJob job = new QuickHackProcessJob();
        try
        {
            job.Assign(started);
        }
        catch
        {
            job.Dispose();
            try { started.Kill(); } catch { }
            started.Dispose();
            throw;
        }
        lock (synchronization)
        {
            child = started;
            processJob = job;
            stopping = false;
        }
        TryLogCode("CHILD_STARTED", EventLogEntryType.Information);
        ThreadPool.QueueUserWorkItem(delegate { MonitorChild(started); });
    }

    protected override void OnStop()
    {
        StopChildTree();
    }

    protected override void OnShutdown()
    {
        StopChildTree();
        base.OnShutdown();
    }

    private void MonitorChild(Process observedChild)
    {
        try
        {
            observedChild.WaitForExit();
            bool unexpected;
            lock (synchronization)
            {
                unexpected = !stopping && Object.ReferenceEquals(child, observedChild);
            }
            if (unexpected)
            {
                ExitCode = observedChild.ExitCode == 0 ? 1 : observedChild.ExitCode;
                TryLogCode("CHILD_EXIT_UNEXPECTED", EventLogEntryType.Error);
                Stop();
            }
        }
        catch (Exception)
        {
            TryLogCode("CHILD_MONITOR_FAILED", EventLogEntryType.Error);
        }
    }

    private void StopChildTree()
    {
        Process stoppedChild;
        QuickHackProcessJob stoppedJob;
        lock (synchronization)
        {
            stopping = true;
            stoppedChild = child;
            stoppedJob = processJob;
            child = null;
            processJob = null;
        }
        try
        {
            if (stoppedJob != null) stoppedJob.Terminate(0);
            if (stoppedChild != null && !stoppedChild.HasExited)
            {
                stoppedChild.WaitForExit(15000);
            }
        }
        finally
        {
            if (stoppedChild != null) stoppedChild.Dispose();
            if (stoppedJob != null) stoppedJob.Dispose();
            TryLogCode("CHILD_STOPPED", EventLogEntryType.Information);
        }
    }

    private void TryLogCode(string code, EventLogEntryType entryType)
    {
        string message = "code=" + code + " service=" + ServiceName;
        try { EventLog.WriteEntry(message, entryType); } catch { }
        try
        {
            string logDirectory = Path.Combine(definition.MutableRoot, "logs");
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "packaged-service-host.log"),
                DateTimeOffset.UtcNow.ToString("O") + " " + message + Environment.NewLine,
                new System.Text.UTF8Encoding(false)
            );
        }
        catch { }
    }
}

internal sealed class QuickHackProcessJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private IntPtr handle;

    internal QuickHackProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        JobObjectExtendedLimitInformation information = new JobObjectExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
        if (!SetInformationJobObject(handle, 9, ref information, (uint)length))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(handle);
            handle = IntPtr.Zero;
            throw new Win32Exception(error);
        }
    }

    internal void Assign(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    internal void Terminate(uint exitCode)
    {
        if (handle != IntPtr.Zero && !TerminateJobObject(handle, exitCode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
        GC.SuppressFinalize(this);
    }

    ~QuickHackProcessJob()
    {
        Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
