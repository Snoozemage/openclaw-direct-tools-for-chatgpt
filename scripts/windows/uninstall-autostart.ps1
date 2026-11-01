[CmdletBinding()]
param([switch]$StopService)

$ErrorActionPreference = 'Stop'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StartupValueName = 'OpenClaw Direct Tools'
$StartupFolder = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupFolder 'OpenClaw Direct Tools.lnk'
$LegacyTaskNames = @(
    'ChatGPT OpenClaw Direct Tools AutoStart',
    'ChatGPT OpenClaw Direct Tools Tray',
    'OpenClaw Gateway (ChatGPT Bridge)'
)

if ($StopService) {
    & (Join-Path $PSScriptRoot 'service-stop.ps1')
    if (-not $?) { throw 'Could not stop OpenClaw Direct Tools before removing autostart.' }
}

if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
}

# Also remove the legacy Registry Run entry created by earlier versions.
if (Test-Path -LiteralPath $RunKey) {
    Remove-ItemProperty -LiteralPath $RunKey -Name $StartupValueName -ErrorAction SilentlyContinue
}

foreach ($taskName in $LegacyTaskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed legacy Scheduled Task: $taskName" -ForegroundColor Yellow
    }
}

Write-Host 'OpenClaw Direct Tools Startup shortcut and legacy registrations removed.' -ForegroundColor Green
