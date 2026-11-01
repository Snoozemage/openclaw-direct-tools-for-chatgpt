Option Explicit

Dim shell, fileSystem, powerShellPath, scriptPath, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count <> 1 Then
    WScript.Quit 64
End If

scriptPath = fileSystem.GetAbsolutePathName(WScript.Arguments(0))
If Not fileSystem.FileExists(scriptPath) Then
    WScript.Quit 66
End If

powerShellPath = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powerShellPath & """ -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"

' Run with window style 0 so console-based PowerShell hosts never surface a terminal window.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
