using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("OpenClaw Direct Tools")]
[assembly: AssemblyDescription("OpenClaw Direct Tools for ChatGPT")]
[assembly: AssemblyCompany("Snoozemage")]
[assembly: AssemblyProduct("OpenClaw Direct Tools for ChatGPT")]
[assembly: AssemblyCopyright("Copyright © Snoozemage")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class StartupLauncher
{
    [STAThread]
    private static int Main()
    {
        string repoRoot = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string serviceStartScript = Path.Combine(repoRoot, "scripts", "windows", "service-start.ps1");
        string powerShellPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");

        try
        {
            if (!File.Exists(serviceStartScript))
                throw new FileNotFoundException("The service startup script was not found.", serviceStartScript);

            if (!File.Exists(powerShellPath))
                throw new FileNotFoundException("Windows PowerShell was not found.", powerShellPath);

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powerShellPath;
            startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" +
                serviceStartScript + "\"";
            startInfo.WorkingDirectory = repoRoot;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                    throw new InvalidOperationException("Windows PowerShell did not start.");
            }

            return 0;
        }
        catch (Exception error)
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
                    "[" + DateTime.Now.ToString("o") + "] " + error + Environment.NewLine);
            }
            catch
            {
                // Logging must not surface a console window or block sign-in.
            }

            return 1;
        }
    }
}
