[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw 'Run setup.ps1 before starting the Gateway task.' }
$cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
foreach ($key in @('openclawHome','openclawStateDir','openclawConfigPath','openclawCliPath','nodePath','gatewayPort','logDir')) {
    if ($null -eq $cfg.$key -or [string]::IsNullOrWhiteSpace([string]$cfg.$key)) { throw "Local config is missing '$key'." }
}

$LogDir = [string]$cfg.logDir
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'gateway-task.log'
$StdoutLog = Join-Path $LogDir 'gateway.stdout.log'
$StderrLog = Join-Path $LogDir 'gateway.stderr.log'
$StopRequestFile = Join-Path $AppHome 'gateway-task.stop'
$Port = [int]$cfg.gatewayPort
$NodePath = [string]$cfg.nodePath
$CliPath = [string]$cfg.openclawCliPath
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$env:OPENCLAW_HOME = [string]$cfg.openclawHome
$env:OPENCLAW_STATE_DIR = [string]$cfg.openclawStateDir
$env:OPENCLAW_CONFIG_PATH = [string]$cfg.openclawConfigPath
$env:OPENCLAW_WORKSPACE_DIR = Join-Path ([string]$cfg.openclawStateDir) 'workspace'
$env:OPENCLAW_CLI_PATH = $CliPath
$env:OPENCLAW_NODE_PATH = $NodePath
$env:TMPDIR = Join-Path $env:LOCALAPPDATA 'Temp'

function Write-GatewayLog([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value "[$stamp] $Message"
}

function Get-GatewayListener {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $proc) { throw "Gateway port $Port is occupied by PID $($listener.OwningProcess), but its process could not be inspected." }
    $expected = $proc.ExecutablePath -ieq $NodePath -and $proc.CommandLine -and
        $proc.CommandLine.IndexOf($CliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $proc.CommandLine -match 'gateway\s+run' -and $proc.CommandLine -match ('--port\s+' + $Port + '(\s|$)')
    if (-not $expected) { throw "Gateway port $Port is occupied by an unexpected process (PID $($listener.OwningProcess)); refusing to replace it." }
    return $proc
}

function Test-GatewayRpc {
    $output = & $NodePath $CliPath gateway status --json 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $false }
    try { return [bool](($output | ConvertFrom-Json).rpc.ok) } catch { return $false }
}

Write-GatewayLog "Gateway supervisor started (PID $PID), port=$Port."
Push-Location ([string]$cfg.openclawHome)
try {
    while (-not (Test-Path -LiteralPath $StopRequestFile)) {
        $existing = Get-GatewayListener
        if ($existing) {
            $gatewayPid = [int]$existing.ProcessId
            Write-GatewayLog "Adopting existing Gateway process PID $gatewayPid; it will be monitored and stopped only after an explicit Gateway stop request."
            $readyDeadline = (Get-Date).AddSeconds(300)
            $rpcReady = $false
            while ((Get-Date) -lt $readyDeadline) {
                if (-not (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)) { break }
                if (Test-GatewayRpc) {
                    $rpcReady = $true
                    break
                }
                Start-Sleep -Seconds 3
            }
            if (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue) {
                if (-not $rpcReady) { throw "Existing Gateway PID $gatewayPid did not become RPC-ready within 300 seconds." }
                Write-GatewayLog "Existing Gateway PID $gatewayPid is RPC-ready; monitoring its lifetime. An explicit stop request may stop this verified process."
                while ((Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $StopRequestFile)) { Start-Sleep -Seconds 2 }
                if (Test-Path -LiteralPath $StopRequestFile) {
                    if (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue) { Stop-Process -Id $gatewayPid -Force -ErrorAction SilentlyContinue }
                    Write-GatewayLog "Stop requested; terminated verified Gateway PID $gatewayPid."
                    break
                }
                Write-GatewayLog "Adopted Gateway PID $gatewayPid exited; checking whether the port is free for recovery."
            }
        } else {
            foreach ($path in @($StdoutLog, $StderrLog)) {
                if (Test-Path -LiteralPath $path) {
                    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                    Move-Item -LiteralPath $path -Destination ($path + '.' + $stamp + '.previous') -Force
                }
            }
            Write-GatewayLog 'Gateway is not listening; starting a new Gateway process.'
            $args = '"' + $CliPath + '" gateway run --port ' + $Port
            $process = Start-Process -FilePath $NodePath -ArgumentList $args -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
            Write-GatewayLog "Started Gateway PID $($process.Id)."
            $readyDeadline = (Get-Date).AddSeconds(300)
            $ready = $false
            while ((Get-Date) -lt $readyDeadline) {
                $process.Refresh()
                if ($process.HasExited) { break }
                if (Test-GatewayRpc) { $ready = $true; break }
                Start-Sleep -Seconds 3
            }
            if ($ready) {
                Write-GatewayLog "Gateway PID $($process.Id) is RPC-ready; monitoring its lifetime."
                while (-not $process.HasExited -and -not (Test-Path -LiteralPath $StopRequestFile)) {
                    Start-Sleep -Seconds 2
                    $process.Refresh()
                }
                if ((Test-Path -LiteralPath $StopRequestFile) -and -not $process.HasExited) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                    $process.WaitForExit(10000) | Out-Null
                    Write-GatewayLog "Stop requested; terminated owned Gateway PID $($process.Id)."
                }
            } else {
                $process.Refresh()
                $exitCode = if ($process.HasExited) { [string]$process.ExitCode } else { 'readiness-timeout' }
                Write-GatewayLog "Gateway PID $($process.Id) failed readiness (exit=$exitCode); see gateway.stdout.log and gateway.stderr.log."
                if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
            }
            $process.Refresh()
            if ($process.HasExited) { Write-GatewayLog "Gateway PID $($process.Id) exited with code $($process.ExitCode)." }
            $process.Dispose()
        }
        if (Test-Path -LiteralPath $StopRequestFile) { break }
        Write-GatewayLog 'Gateway supervisor will retry in 15 seconds.'
        Start-Sleep -Seconds 15
    }
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $StopRequestFile -Force -ErrorAction SilentlyContinue
    Write-GatewayLog 'Gateway supervisor process is exiting.'
}
