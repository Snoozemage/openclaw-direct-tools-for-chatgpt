[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
if (-not (Test-Path -LiteralPath $ConfigFile)) { Write-Host 'No local configuration is installed.'; exit 0 }
$cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
$BridgePidFile = Join-Path $AppHome 'bridge.pid'
$BridgeSupervisorPidFile = Join-Path $AppHome 'bridge-supervisor.pid'
$BridgeSupervisorStopFile = Join-Path $AppHome 'bridge-supervisor.stop'
$TunnelPidFile = Join-Path $AppHome 'tunnel-client.pid'

function Stop-OwnedProcess([string]$PidFile, [string]$ExpectedExecutable, [string]$ExpectedArgument) {
    if (-not (Test-Path -LiteralPath $PidFile)) { return }
    $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $id = 0
    if (-not [int]::TryParse($raw, [ref]$id) -or $id -le 0) { Remove-Item -LiteralPath $PidFile -Force; return }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($null -eq $proc) { Remove-Item -LiteralPath $PidFile -Force; return }
    $exeMatches = $ExpectedExecutable -and $proc.ExecutablePath -and ($proc.ExecutablePath -ieq $ExpectedExecutable)
    $argMatches = $ExpectedArgument -and $proc.CommandLine -and ($proc.CommandLine -like ('*' + $ExpectedArgument + '*'))
    $owned = [bool]($exeMatches -and $argMatches)
    if (-not $owned) {
        Write-Warning "PID $id no longer matches the expected application; leaving it untouched."
        Remove-Item -LiteralPath $PidFile -Force
        return
    }
    Stop-Process -Id $id -Force -ErrorAction Stop
    Remove-Item -LiteralPath $PidFile -Force
    Write-Host "Stopped $($proc.Name) (PID $id)." -ForegroundColor Green
}

function Stop-BridgeSupervisor {
    if (-not (Test-Path -LiteralPath $BridgeSupervisorPidFile)) { return }
    $id = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $BridgeSupervisorPidFile -Raw).Trim(), [ref]$id) -or $id -le 0) {
        Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force
        return
    }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force
        return
    }

    $supervisorScript = Join-Path $PSScriptRoot 'bridge-supervisor.ps1'
    $expectedExecutable = Join-Path $PSHOME 'powershell.exe'
    $owned = $proc.ExecutablePath -ieq $expectedExecutable -and $proc.CommandLine -and $proc.CommandLine.IndexOf($supervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $owned) {
        Write-Warning "PID $id no longer matches the bridge supervisor; leaving it untouched."
        Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force
        return
    }

    Set-Content -LiteralPath $BridgeSupervisorStopFile -Value 'stop' -Encoding ASCII
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Id $id -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
        Write-Warning "Bridge supervisor PID $id did not stop cleanly; terminating the supervisor process."
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $BridgeSupervisorPidFile) {
        $current = 0
        if ([int]::TryParse((Get-Content -LiteralPath $BridgeSupervisorPidFile -Raw).Trim(), [ref]$current) -and $current -eq $id) {
            Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force
        }
    }
    Remove-Item -LiteralPath $BridgeSupervisorStopFile -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped bridge supervisor (PID $id)." -ForegroundColor Green
}

$bridgePath = Join-Path ([string]$cfg.repoPath) 'src\server.mjs'
Stop-BridgeSupervisor
Stop-OwnedProcess -PidFile $BridgePidFile -ExpectedExecutable ([string]$cfg.nodePath) -ExpectedArgument $bridgePath
Stop-OwnedProcess -PidFile $TunnelPidFile -ExpectedExecutable ([string]$cfg.tunnelClientPath) -ExpectedArgument 'tunnel-client'
Write-Host 'Stop complete. OpenClaw Gateway is independently managed and remains running.' -ForegroundColor Cyan
