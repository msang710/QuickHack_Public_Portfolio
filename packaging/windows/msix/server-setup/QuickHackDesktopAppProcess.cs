using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class QuickHackDesktopAppProcess
{
    private const uint HandleFlagInherit = 0x00000001;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint Infinite = 0xFFFFFFFF;
    private const uint WaitObject0 = 0x00000000;
    private const int ProcThreadAttributeHandleList = 0x00020002;
    private const int ProcThreadAttributeDesktopAppPolicy = 0x00020012;
    private const int ProcessCreationDesktopAppBreakawayDisableProcessTree = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        internal int InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal int Size;
        internal string Reserved;
        internal string Desktop;
        internal string Title;
        internal uint X;
        internal uint Y;
        internal uint XSize;
        internal uint YSize;
        internal uint XCountChars;
        internal uint YCountChars;
        internal uint FillAttribute;
        internal uint Flags;
        internal ushort ShowWindow;
        internal ushort Reserved2Size;
        internal IntPtr Reserved2;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SecurityAttributes pipeAttributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize
    );

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    internal static StringDictionary InheritCurrentEnvironment()
    {
        StringDictionary result = new StringDictionary();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            result[(string)entry.Key] = (string)entry.Value;
        }
        return result;
    }

    internal static int Run(
        string application,
        string arguments,
        string workingDirectory,
        StringDictionary environment,
        Action<string> outputLine,
        Action<string> errorLine
    )
    {
        if (String.IsNullOrWhiteSpace(application) || application.IndexOf('\0') >= 0)
        {
            throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_INPUT_INVALID", 0);
        }
        if (String.IsNullOrWhiteSpace(workingDirectory) || workingDirectory.IndexOf('\0') >= 0)
        {
            throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_INPUT_INVALID", 0);
        }
        if (environment == null || outputLine == null || errorLine == null)
        {
            throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_INPUT_INVALID", 0);
        }

        IntPtr standardOutputRead = IntPtr.Zero;
        IntPtr standardOutputWrite = IntPtr.Zero;
        IntPtr standardErrorRead = IntPtr.Zero;
        IntPtr standardErrorWrite = IntPtr.Zero;
        IntPtr standardInputRead = IntPtr.Zero;
        IntPtr standardInputWrite = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr desktopPolicy = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        bool attributeListInitialized = false;
        ProcessInformation processInformation = new ProcessInformation();
        StreamReader outputReader = null;
        StreamReader errorReader = null;
        bool processCompleted = false;

        try
        {
            SecurityAttributes pipeAttributes = new SecurityAttributes();
            pipeAttributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            pipeAttributes.SecurityDescriptor = IntPtr.Zero;
            pipeAttributes.InheritHandle = 1;

            CreateParentReadPipe(
                ref pipeAttributes,
                out standardOutputRead,
                out standardOutputWrite
            );
            CreateParentReadPipe(
                ref pipeAttributes,
                out standardErrorRead,
                out standardErrorWrite
            );
            CreateChildReadPipe(
                ref pipeAttributes,
                out standardInputRead,
                out standardInputWrite
            );

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeListSize);
            int attributeListError = Marshal.GetLastWin32Error();
            if (attributeListSize == IntPtr.Zero)
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                    attributeListError
                );
            }
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeListSize))
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                    Marshal.GetLastWin32Error()
                );
            }
            attributeListInitialized = true;

            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, standardInputRead);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, standardOutputWrite);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, standardErrorWrite);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeHandleList),
                handleList,
                new IntPtr(IntPtr.Size * 3),
                IntPtr.Zero,
                IntPtr.Zero
            ))
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                    Marshal.GetLastWin32Error()
                );
            }

            desktopPolicy = Marshal.AllocHGlobal(sizeof(int));
            Marshal.WriteInt32(
                desktopPolicy,
                ProcessCreationDesktopAppBreakawayDisableProcessTree
            );
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(ProcThreadAttributeDesktopAppPolicy),
                desktopPolicy,
                new IntPtr(sizeof(int)),
                IntPtr.Zero,
                IntPtr.Zero
            ))
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                    Marshal.GetLastWin32Error()
                );
            }

            environmentBlock = BuildEnvironmentBlock(environment);
            StartupInfoEx startupInfo = new StartupInfoEx();
            startupInfo.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startupInfo.StartupInfo.Flags = StartfUseStdHandles;
            startupInfo.StartupInfo.StandardInput = standardInputRead;
            startupInfo.StartupInfo.StandardOutput = standardOutputWrite;
            startupInfo.StartupInfo.StandardError = standardErrorWrite;
            startupInfo.AttributeList = attributeList;

            StringBuilder commandLine = new StringBuilder();
            commandLine.Append(QuoteApplication(application));
            if (!String.IsNullOrEmpty(arguments))
            {
                commandLine.Append(' ');
                commandLine.Append(arguments);
            }
            if (!CreateProcessW(
                application,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateUnicodeEnvironment | CreateNoWindow | ExtendedStartupInfoPresent,
                environmentBlock,
                workingDirectory,
                ref startupInfo,
                out processInformation
            ))
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_CREATE_FAILED",
                    Marshal.GetLastWin32Error()
                );
            }

            CloseNativeHandle(ref processInformation.Thread);
            CloseNativeHandle(ref standardInputRead);
            CloseNativeHandle(ref standardInputWrite);
            CloseNativeHandle(ref standardOutputWrite);
            CloseNativeHandle(ref standardErrorWrite);

            outputReader = CreateReader(standardOutputRead);
            standardOutputRead = IntPtr.Zero;
            errorReader = CreateReader(standardErrorRead);
            standardErrorRead = IntPtr.Zero;

            Exception outputFailure = null;
            Exception errorFailure = null;
            Thread outputThread = new Thread(delegate()
            {
                outputFailure = ReadLines(outputReader, outputLine);
            });
            Thread errorThread = new Thread(delegate()
            {
                errorFailure = ReadLines(errorReader, errorLine);
            });
            outputThread.IsBackground = true;
            errorThread.IsBackground = true;
            outputThread.Name = "QuickHack Setup stdout";
            errorThread.Name = "QuickHack Setup stderr";
            outputThread.Start();
            errorThread.Start();

            uint waitResult = WaitForSingleObject(processInformation.Process, Infinite);
            int waitError = Marshal.GetLastWin32Error();
            outputThread.Join();
            errorThread.Join();
            if (waitResult != WaitObject0)
            {
                throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_WAIT_FAILED", waitError);
            }
            if (outputFailure != null) throw outputFailure;
            if (errorFailure != null) throw errorFailure;

            uint exitCode;
            if (!GetExitCodeProcess(processInformation.Process, out exitCode))
            {
                throw StableFailure(
                    "SERVER_SETUP_PACKAGE_CONTEXT_WAIT_FAILED",
                    Marshal.GetLastWin32Error()
                );
            }
            processCompleted = true;
            return unchecked((int)exitCode);
        }
        finally
        {
            if (outputReader != null) outputReader.Dispose();
            if (errorReader != null) errorReader.Dispose();
            CloseNativeHandle(ref processInformation.Thread);
            if (processInformation.Process != IntPtr.Zero && !processCompleted)
            {
                TerminateProcess(processInformation.Process, 1);
                WaitForSingleObject(processInformation.Process, Infinite);
            }
            CloseNativeHandle(ref processInformation.Process);
            CloseNativeHandle(ref standardOutputRead);
            CloseNativeHandle(ref standardOutputWrite);
            CloseNativeHandle(ref standardErrorRead);
            CloseNativeHandle(ref standardErrorWrite);
            CloseNativeHandle(ref standardInputRead);
            CloseNativeHandle(ref standardInputWrite);
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (desktopPolicy != IntPtr.Zero) Marshal.FreeHGlobal(desktopPolicy);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    private static void CreateParentReadPipe(
        ref SecurityAttributes attributes,
        out IntPtr parentRead,
        out IntPtr childWrite
    )
    {
        if (!CreatePipe(out parentRead, out childWrite, ref attributes, 0))
        {
            throw StableFailure(
                "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                Marshal.GetLastWin32Error()
            );
        }
        if (!SetHandleInformation(parentRead, HandleFlagInherit, 0))
        {
            throw StableFailure(
                "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                Marshal.GetLastWin32Error()
            );
        }
    }

    private static void CreateChildReadPipe(
        ref SecurityAttributes attributes,
        out IntPtr childRead,
        out IntPtr parentWrite
    )
    {
        if (!CreatePipe(out childRead, out parentWrite, ref attributes, 0))
        {
            throw StableFailure(
                "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                Marshal.GetLastWin32Error()
            );
        }
        if (!SetHandleInformation(parentWrite, HandleFlagInherit, 0))
        {
            throw StableFailure(
                "SERVER_SETUP_PACKAGE_CONTEXT_INITIALIZE_FAILED",
                Marshal.GetLastWin32Error()
            );
        }
    }

    private static IntPtr BuildEnvironmentBlock(StringDictionary environment)
    {
        List<string> entries = new List<string>();
        foreach (DictionaryEntry entry in environment)
        {
            string name = (string)entry.Key;
            string value = (string)entry.Value;
            if (
                String.IsNullOrEmpty(name) ||
                name.IndexOf('\0') >= 0 ||
                name.IndexOf('=') >= 0 ||
                (value != null && value.IndexOf('\0') >= 0)
            )
            {
                throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_INPUT_INVALID", 0);
            }
            entries.Add(name + "=" + (value ?? String.Empty));
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string entry in entries)
        {
            block.Append(entry);
            block.Append('\0');
        }
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static StreamReader CreateReader(IntPtr handle)
    {
        SafeFileHandle safeHandle = new SafeFileHandle(handle, true);
        FileStream stream = new FileStream(safeHandle, FileAccess.Read, 4096, false);
        return new StreamReader(stream, new UTF8Encoding(false, false), true, 4096);
    }

    private static Exception ReadLines(StreamReader reader, Action<string> callback)
    {
        Exception callbackFailure = null;
        try
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (callbackFailure != null) continue;
                try
                {
                    callback(line);
                }
                catch (Exception error)
                {
                    callbackFailure = error;
                }
            }
        }
        catch (Exception error)
        {
            if (callbackFailure == null) callbackFailure = error;
        }
        return callbackFailure;
    }

    private static string QuoteApplication(string value)
    {
        if (value.IndexOf('"') >= 0)
        {
            throw StableFailure("SERVER_SETUP_PACKAGE_CONTEXT_INPUT_INVALID", 0);
        }
        return "\"" + value + "\"";
    }

    private static InvalidOperationException StableFailure(string code, int nativeError)
    {
        return new InvalidOperationException(
            code + (nativeError == 0 ? String.Empty : " nativeError=" + nativeError.ToString())
        );
    }

    private static void CloseNativeHandle(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
        CloseHandle(handle);
        handle = IntPtr.Zero;
    }
}
