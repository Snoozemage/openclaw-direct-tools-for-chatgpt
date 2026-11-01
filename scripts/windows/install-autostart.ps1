[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StartupValueName = 'OpenClaw Direct Tools'
$LauncherSource = Join-Path $PSScriptRoot 'startup-launcher.cs'
$ServiceStartScript = Join-Path $PSScriptRoot 'service-start.ps1'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$IconPath = Join-Path $RepoRoot 'assets\openclaw-direct-tools.ico'
$LauncherExecutable = Join-Path $RepoRoot 'assets\OpenClaw Direct Tools.exe'
$LegacyLauncherExecutable = Join-Path $RepoRoot 'assets\OpenClaw Direct Tools for ChatGPT.exe'
$CompilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$CompilerPath = $CompilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder 'OpenClaw Direct Tools.lnk'
$LegacyTaskNames = @(
    'ChatGPT OpenClaw Direct Tools AutoStart',
    'ChatGPT OpenClaw Direct Tools Tray',
    'OpenClaw Gateway (ChatGPT Bridge)'
)

foreach ($path in @($LauncherSource, $ServiceStartScript, $IconPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required startup file not found: $path" }
}
if (-not (Test-Path -LiteralPath $StartupFolder -PathType Container)) {
    throw "Windows Startup folder not found: $StartupFolder"
}

if ($CompilerPath) {
    & $CompilerPath /nologo /target:winexe /optimize+ ("/out:" + $LauncherExecutable) ("/win32icon:" + $IconPath) $LauncherSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf)) {
        throw "Could not build the branded startup launcher (compiler exit=$LASTEXITCODE)."
    }
    Write-Host 'Built the startup launcher from source using the .NET Framework C# compiler.' -ForegroundColor Cyan
}
elseif (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf) {
    Write-Host 'C# compiler not found; using the bundled startup launcher executable.' -ForegroundColor Yellow
}
else {
    throw 'The C# compiler was not found and the bundled startup launcher is missing. Restore assets\OpenClaw Direct Tools.exe or install the .NET Framework 4.x developer tools.'
}
if (Test-Path -LiteralPath $LegacyLauncherExecutable) {
    Remove-Item -LiteralPath $LegacyLauncherExecutable -Force
}

# Recreate the shortcut so Windows refreshes its target executable and icon metadata.
if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
}
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $LauncherExecutable
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $RepoRoot
$shortcut.Description = 'OpenClaw Direct Tools for ChatGPT'
$shortcut.IconLocation = $LauncherExecutable + ',0'
$shortcut.WindowStyle = 7
$shortcut.Save()
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutShell)

# Migrate from the previous Registry Run entry so only the Startup shortcut remains.
if (Test-Path -LiteralPath $RunKey) {
    Remove-ItemProperty -LiteralPath $RunKey -Name $StartupValueName -ErrorAction SilentlyContinue
}

foreach ($taskName in $LegacyTaskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { continue }

    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(8)
        do {
            Start-Sleep -Milliseconds 250
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        } while ($task -and $task.State -eq 'Running' -and (Get-Date) -lt $deadline)
    }

    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed legacy Scheduled Task: $taskName" -ForegroundColor Yellow
}

Write-Host "Registered one Startup Apps shortcut: $ShortcutPath" -ForegroundColor Green
Write-Host 'Open Task Manager > Startup apps to enable or disable OpenClaw Direct Tools.' -ForegroundColor Cyan
$launcherProcess = Start-Process -FilePath $LauncherExecutable -WorkingDirectory $RepoRoot -WindowStyle Hidden -Wait -PassThru
if ($launcherProcess.ExitCode -ne 0) {
    throw "The startup entry was registered, but its launcher failed (exit=$($launcherProcess.ExitCode)). Check startup-launcher.log."
}
