[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$StopScript = Join-Path $PSScriptRoot 'stop.ps1'
$StartScript = Join-Path $PSScriptRoot 'start.ps1'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$LogDir = Join-Path $AppHome 'logs'
$LogFile = Join-Path $LogDir 'tray-restart.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-RestartLog([string]$Message) {
    $entry = '[' + (Get-Date).ToString('o') + '] ' + $Message + [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $entry, [Text.UTF8Encoding]::new($false))
}

try {
    if (-not (Test-Path -LiteralPath $StopScript -PathType Leaf) -or -not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
        throw 'Bridge lifecycle scripts are missing.'
    }

    Write-RestartLog 'Restart requested from the system tray.'
    & $StopScript *>&1 | ForEach-Object {
        $line = ($_ | Out-String -Width 240).TrimEnd()
        if ($line) { Write-RestartLog $line }
    }
    & $StartScript -NoBrowser *>&1 | ForEach-Object {
        $line = ($_ | Out-String -Width 240).TrimEnd()
        if ($line) { Write-RestartLog $line }
    }
    Write-RestartLog 'Bridge restart completed.'
    exit 0
} catch {
    Write-RestartLog ('Bridge restart failed: ' + $_.Exception.Message)
    exit 1
}
