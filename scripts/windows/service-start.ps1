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

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path -LiteralPath $SupervisorScript -PathType Leaf)) { throw "Service supervisor not found: $SupervisorScript" }

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
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $SupervisorScript + '"'
$process = Start-Process -FilePath $PowerShell -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(12)
do {
    Start-Sleep -Milliseconds 250
    $owned = Get-OwnedSupervisor $process.Id
    if ($owned -and (Test-Path -LiteralPath $PidFile)) {
        Write-Host "OpenClaw Direct Tools started (PID $($process.Id))." -ForegroundColor Green
        return
    }

    $process.Refresh()
    if ($process.HasExited) {
        $log = Join-Path $LogDir 'service-supervisor.log'
        if (Test-Path -LiteralPath $log) {
            Write-Host ((Get-Content -LiteralPath $log -Tail 20) -join [Environment]::NewLine) -ForegroundColor Yellow
        }
        throw "Service supervisor exited during startup (code $($process.ExitCode))."
    }
} while ((Get-Date) -lt $deadline)

throw "Service supervisor did not publish its PID file within 12 seconds. Inspect $(Join-Path $LogDir 'service-supervisor.log')."
