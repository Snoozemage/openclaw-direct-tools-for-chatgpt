Option Explicit

Dim shell, fileSystem, scriptDirectory, powerShellPath, trayScript, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellPath = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
trayScript = scriptDirectory & "\tray-app.ps1"

command = """" & powerShellPath & """ -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """"

' Run with window style 0 (hidden) and wait so Task Scheduler tracks the tray app lifecycle.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
