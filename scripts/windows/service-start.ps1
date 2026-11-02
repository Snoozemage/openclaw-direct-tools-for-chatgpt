[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$SupervisorScript = Join-Path $PSScriptRoot 'service-supervisor.ps1'
$PidFile = Join-Path $AppHome 'service.pid'
$StopFile = Join-Path $AppHome 'service.stop'
$LogDir = Join-Path $AppHome 'logs'
$PowerShell = Join-Path $PSHOME 'powershell.exe'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$LauncherExecutable = Join-Path $RepoRoot 'assets\OpenClaw Direct Tools.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path -LiteralPath $SupervisorScript -PathType Leaf)) { throw "Service supervisor not found: $SupervisorScript" }
if (-not (Test-Path -LiteralPath $LauncherExecutable -PathType Leaf)) { throw "Service guardian executable not found: $LauncherExecutable" }

function Get-OwnedSupervisor([int]$ProcessId = 0) {
    if ($ProcessId -le 0) {
        if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
        if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$ProcessId) -or $ProcessId -le 0) {
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
            return $null
        }
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath -ieq $PowerShell -and $process.CommandLine -and
        $process.CommandLine.IndexOf($SupervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $process
    }

    return $null
}

$existing = Get-OwnedSupervisor
if ($existing) {
    Write-Host "OpenClaw Direct Tools is already running (PID $($existing.ProcessId))." -ForegroundColor Green
    return
}

Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
$guardian = Start-Process -FilePath $LauncherExecutable -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(12)
do {
    Start-Sleep -Milliseconds 250
    $owned = Get-OwnedSupervisor
    if ($owned) {
        Write-Host "OpenClaw Direct Tools started (supervisor PID $($owned.ProcessId); guardian PID $($guardian.Id))." -ForegroundColor Green
        return
    }

    $guardian.Refresh()
    if ($guardian.HasExited) {
        foreach ($logName in @('startup-launcher.log', 'service-supervisor.log')) {
            $log = Join-Path $LogDir $logName
            if (Test-Path -LiteralPath $log) {
                Write-Host ((Get-Content -LiteralPath $log -Tail 20) -join [Environment]::NewLine) -ForegroundColor Yellow
            }
        }
        throw "Service guardian exited during startup (code $($guardian.ExitCode))."
    }
} while ((Get-Date) -lt $deadline)

throw "Service guardian did not publish a valid supervisor PID within 12 seconds. Inspect the logs in $LogDir."
