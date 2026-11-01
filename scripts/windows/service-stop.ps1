[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$PidFile = Join-Path $AppHome 'service.pid'
$StopFile = Join-Path $AppHome 'service.stop'
$SupervisorScript = Join-Path $PSScriptRoot 'service-supervisor.ps1'
$PowerShell = Join-Path $PSHOME 'powershell.exe'

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

$supervisor = Get-OwnedSupervisor
if (-not $supervisor) {
    Remove-Item -LiteralPath $PidFile,$StopFile -Force -ErrorAction SilentlyContinue
    Write-Host 'OpenClaw Direct Tools is already stopped.' -ForegroundColor Yellow
    return
}

Set-Content -LiteralPath $StopFile -Value 'stop' -Encoding ASCII
Write-Host "Stopping OpenClaw Direct Tools (PID $($supervisor.ProcessId)) ..." -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds(45)
do {
    Start-Sleep -Milliseconds 250
    $current = Get-OwnedSupervisor ([int]$supervisor.ProcessId)
} while ($current -and (Get-Date) -lt $deadline)

if ($current) {
    Write-Warning 'The supervisor did not complete graceful shutdown in 45 seconds. Terminating the verified supervisor; its Windows Job Object should release the managed process tree.'
    Stop-Process -Id ([int]$supervisor.ProcessId) -Force -ErrorAction SilentlyContinue
    Wait-Process -Id ([int]$supervisor.ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $PidFile,$StopFile -Force -ErrorAction SilentlyContinue
if (Get-Process -Id ([int]$supervisor.ProcessId) -ErrorAction SilentlyContinue) {
    throw "The service supervisor PID $($supervisor.ProcessId) is still running."
}

Write-Host 'OpenClaw Direct Tools stopped.' -ForegroundColor Green
