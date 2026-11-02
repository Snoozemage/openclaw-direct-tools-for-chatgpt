using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("OpenClaw Direct Tools")]
[assembly: AssemblyDescription("OpenClaw Direct Tools for ChatGPT")]
[assembly: AssemblyCompany("Snoozemage")]
[assembly: AssemblyProduct("OpenClaw Direct Tools for ChatGPT")]
[assembly: AssemblyCopyright("Copyright © Snoozemage")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

public static class OpenClawDirectToolsNativeMethods
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr handle);
}

internal static class StartupLauncher
{
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;

    private static IntPtr jobHandle = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref ExtendedLimitInformation information,
        uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    private static int Main()
    {
        string repoRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string supervisorScript = Path.Combine(repoRoot, "scripts", "windows", "service-supervisor.ps1");
        string powerShellPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");

        try
        {
            if (!File.Exists(supervisorScript))
                throw new FileNotFoundException("The service supervisor script was not found.", supervisorScript);

            if (!File.Exists(powerShellPath))
                throw new FileNotFoundException("Windows PowerShell was not found.", powerShellPath);

            string jobStatus = "unavailable";
            try
            {
                jobHandle = CreateAndAssignCurrentProcess();
                jobStatus = "active";
            }
            catch (Exception error)
            {
                WriteLauncherLog("Windows Job Object could not be enabled; graceful shutdown remains available. " + error);
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powerShellPath;
            startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" +
                supervisorScript + "\"";
            startInfo.WorkingDirectory = repoRoot;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                    throw new InvalidOperationException("Windows PowerShell did not start.");

                WriteLauncherLog("Service supervisor started (PID " + process.Id + "; Job Object: " + jobStatus + ").");
                process.WaitForExit();
                WriteLauncherLog("Service supervisor exited (PID " + process.Id + "; exit code " + process.ExitCode + ").");
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            WriteLauncherLog("Startup failed. " + error);
            return 1;
        }

        // The operating system closes jobHandle when this guardian exits.
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE then terminates any remaining
        // supervisor descendants. Do not close this handle before process exit.
    }

    private static IntPtr CreateAndAssignCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());

        ExtendedLimitInformation information = new ExtendedLimitInformation();
        information.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;

        if (!SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            ref information,
            (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }

        if (!AssignProcessToJobObject(job, GetCurrentProcess()))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }

        return job;
    }

    private static void WriteLauncherLog(string message)
    {
        try
        {
            string logDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "OpenClawChatGPTBridge",
                "logs");
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "startup-launcher.log"),
                "[" + DateTime.Now.ToString("o") + "] " + message + Environment.NewLine);
        }
        catch
        {
            // Logging must not show a console window or block startup.
        }
    }
}
