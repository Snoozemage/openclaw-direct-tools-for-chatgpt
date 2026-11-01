[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
$DefaultCredentialTarget = 'OpenClawChatGPTBridge/CONTROL_PLANE_API_KEY'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$BridgePidFile = Join-Path $AppHome 'bridge.pid'
$BridgeSupervisorPidFile = Join-Path $AppHome 'bridge-supervisor.pid'
$BridgeSupervisorStopFile = Join-Path $AppHome 'bridge-supervisor.stop'
$TunnelPidFile = Join-Path $AppHome 'tunnel-client.pid'

function Read-LocalConfig {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { throw 'Run setup.ps1 before start.ps1.' }
    $script:Cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    foreach ($key in @('openclawConfigPath','openclawCliPath','nodePath','tunnelClientPath','tunnelProfilePath','bridgePort','gatewayPort','tunnelHealthPort')) {
        if ($null -eq $script:Cfg.$key -or [string]::IsNullOrWhiteSpace([string]$script:Cfg.$key)) { throw "Local config is missing '$key'. Re-run setup.ps1." }
    }
}
function Get-Json([string]$Url) { try { Invoke-RestMethod -Uri $Url -TimeoutSec 2 } catch { $null } }
function Test-Port([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try { $task = $client.ConnectAsync('127.0.0.1', $Port); return $task.Wait(500) -and $client.Connected }
    catch { return $false } finally { $client.Dispose() }
}
function Wait-Json([string]$Url, [int]$Seconds) {
    $until = (Get-Date).AddSeconds($Seconds)
    do { $v = Get-Json $Url; if ($null -ne $v) { return $v }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $until)
    return $null
}
function Get-BridgeSupervisorProcess([int]$ProcessId = 0) {
    $id = $ProcessId
    if ($id -le 0) {
        if (-not (Test-Path -LiteralPath $BridgeSupervisorPidFile)) { return $null }
        if (-not [int]::TryParse((Get-Content -LiteralPath $BridgeSupervisorPidFile -Raw).Trim(), [ref]$id) -or $id -le 0) {
            Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force
            return $null
        }
    }

    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    $supervisorScript = Join-Path $PSScriptRoot 'bridge-supervisor.ps1'
    $expectedExecutable = Join-Path $PSHOME 'powershell.exe'
    if ($proc -and $proc.ExecutablePath -ieq $expectedExecutable -and $proc.CommandLine -and $proc.CommandLine.IndexOf($supervisorScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $proc
    }

    if ($ProcessId -le 0) { Remove-Item -LiteralPath $BridgeSupervisorPidFile -Force -ErrorAction SilentlyContinue }
    return $null
}
function Start-LoggedProcess([string]$FilePath, [string]$Arguments, [string]$OutFile, [string]$ErrFile, [string]$WorkingDirectory) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($logPath in @($OutFile, $ErrFile)) {
        if (Test-Path -LiteralPath $logPath) { Move-Item -LiteralPath $logPath -Destination ($logPath + '.' + $stamp + '.previous') -Force }
    }
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { $WorkingDirectory = $RepoRoot }
    Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
}

Read-LocalConfig
$Cfg = $script:Cfg
$LogDir = [string]$Cfg.logDir
if (-not $LogDir) { $LogDir = Join-Path $AppHome 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:OPENCLAW_HOME = [string]$Cfg.openclawHome
$env:OPENCLAW_STATE_DIR = [string]$Cfg.openclawStateDir
$env:OPENCLAW_CONFIG_PATH = [string]$Cfg.openclawConfigPath
$env:OPENCLAW_WORKSPACE_DIR = Join-Path ([string]$Cfg.openclawStateDir) 'workspace'
$env:OPENCLAW_CLI_PATH = [string]$Cfg.openclawCliPath
$env:OPENCLAW_NODE_PATH = [string]$Cfg.nodePath
$env:OPENCLAW_BRIDGE_HOST = '127.0.0.1'
$env:OPENCLAW_BRIDGE_PORT = [string]$Cfg.bridgePort
$env:OPENCLAW_BRIDGE_AGENT = if ($Cfg.agentId) { [string]$Cfg.agentId } else { 'main' }
$env:OPENCLAW_GATEWAY_PORT = [string]$Cfg.gatewayPort
$env:OPENCLAW_BRIDGE_INVOKE_TIMEOUT_MS = '120000'

# Fail before starting the bridge/tunnel if the tunnel needs to start but no credential is stored.
$tunnelHealth = 'http://127.0.0.1:' + $Cfg.tunnelHealthPort
$initialTunnelReady = Get-Json ($tunnelHealth + '/readyz')
$initialTunnelHealthy = $initialTunnelReady -and (($initialTunnelReady -is [string] -and $initialTunnelReady.Trim() -eq 'ready') -or $initialTunnelReady.status -eq 'ready')
$tunnelApiKey = $null
if (-not $initialTunnelHealthy) {
    if (Test-Port ([int]$Cfg.tunnelHealthPort)) {
        throw "Tunnel health port $($Cfg.tunnelHealthPort) is occupied but is not reporting ready. Resolve the conflict or update setup."
    }
    $credentialTarget = if ([string]::IsNullOrWhiteSpace([string]$Cfg.credentialTarget)) { $DefaultCredentialTarget } else { [string]$Cfg.credentialTarget }
    $tunnelApiKey = [OpenClawBridge.WindowsCredentialStore]::Load($credentialTarget)
    if ([string]::IsNullOrWhiteSpace($tunnelApiKey)) {
        throw 'The Secure MCP Tunnel API key is not available in Windows Credential Manager. Run npm run setup to store or migrate it before starting the stack.'
    }
}

# The central service supervisor owns Gateway lifecycle. This script waits for RPC readiness before starting bridge components.
$gatewayPort = [int]$Cfg.gatewayPort
$gatewayReady = $false
$gatewayDeadline = (Get-Date).AddSeconds(300)
Write-Host "Waiting for OpenClaw Gateway managed by the central supervisor on 127.0.0.1:$gatewayPort ..."
do {
    if (Test-Port $gatewayPort) {
        $gatewayStatusOutput = & ([string]$Cfg.nodePath) ([string]$Cfg.openclawCliPath) gateway status --json 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            try {
                $gatewayStatus = $gatewayStatusOutput | ConvertFrom-Json
                $gatewayReady = [bool]$gatewayStatus.rpc.ok
            } catch { $gatewayReady = $false }
        }
        if (-not $gatewayReady) { Write-Host 'Gateway listener is open but RPC is not ready yet; waiting for startup admission.' }
    }
    if (-not $gatewayReady) { Start-Sleep -Seconds 3 }
} while (-not $gatewayReady -and (Get-Date) -lt $gatewayDeadline)
if (-not $gatewayReady) {
    throw "The OpenClaw Gateway did not become RPC-ready on port $gatewayPort within 300 seconds. Inspect service-supervisor.log and gateway-task.log."
}
Write-Host "OpenClaw Gateway is RPC-ready on 127.0.0.1:$gatewayPort; bridge startup may proceed." -ForegroundColor Green

$base = 'http://127.0.0.1:' + $Cfg.bridgePort
$scriptPath = Join-Path $RepoRoot 'src\server.mjs'
$supervisorScript = Join-Path $PSScriptRoot 'bridge-supervisor.ps1'
$supervisor = Get-BridgeSupervisorProcess
$supervisorId = 0
$health = Get-Json ($base + '/healthz')

if (-not $supervisor) {
    if ($health -and $health.server -eq 'openclaw-chatgpt-bridge') {
        $existingBridgeId = 0
        if (-not [int]::TryParse([string]$health.pid, [ref]$existingBridgeId) -or $existingBridgeId -le 0) {
            throw 'An unmanaged bridge is responding but did not report its PID. Refusing to replace an unidentified process.'
        }
        $existingBridge = Get-CimInstance Win32_Process -Filter "ProcessId = $existingBridgeId" -ErrorAction SilentlyContinue
        $matchesBridge = $existingBridge -and $existingBridge.ExecutablePath -ieq [string]$Cfg.nodePath -and $existingBridge.CommandLine -and $existingBridge.CommandLine.IndexOf($scriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not $matchesBridge) {
            throw "Bridge health endpoint belongs to an unexpected process (PID $existingBridgeId). Refusing to stop it."
        }
        Write-Host "Moving bridge PID $existingBridgeId under the bridge supervisor..."
        Stop-Process -Id $existingBridgeId -Force
        $exitDeadline = (Get-Date).AddSeconds(10)
        while ((Get-Process -Id $existingBridgeId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $exitDeadline) {
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $existingBridgeId -ErrorAction SilentlyContinue) {
            throw "Unmanaged bridge PID $existingBridgeId did not stop; supervisor startup was cancelled."
        }
    } elseif (Test-Port ([int]$Cfg.bridgePort)) {
        throw "Bridge port $($Cfg.bridgePort) is occupied by a different process. Change it in local config/setup.ps1."
    }

    if (Test-Path -LiteralPath $BridgeSupervisorStopFile) {
        Remove-Item -LiteralPath $BridgeSupervisorStopFile -Force
    }
    Write-Host "Starting bridge supervisor for $base ..."
    $supervisorOut = Join-Path $LogDir 'bridge-supervisor.stdout.log'
    $supervisorErr = Join-Path $LogDir 'bridge-supervisor.stderr.log'
    $supervisorArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $supervisorScript + '"'
    $supervisorProcess = Start-LoggedProcess -FilePath (Join-Path $PSHOME 'powershell.exe') -Arguments $supervisorArgs -OutFile $supervisorOut -ErrFile $supervisorErr -WorkingDirectory $RepoRoot
    $supervisorId = $supervisorProcess.Id
} else {
    $supervisorId = [int]$supervisor.ProcessId
    Write-Host "Bridge supervisor already running (PID $supervisorId)." -ForegroundColor Green
}

$bridgeDeadline = (Get-Date).AddSeconds(45)
$managedHealth = $null
$managedBridgeId = 0
do {
    $supervisor = Get-BridgeSupervisorProcess $supervisorId
    if ($null -eq $supervisor) {
        $details = if (Test-Path -LiteralPath (Join-Path $LogDir 'bridge-supervisor.stderr.log')) { (Get-Content (Join-Path $LogDir 'bridge-supervisor.stderr.log') -Tail 30) -join [Environment]::NewLine } else { 'No supervisor stderr log available.' }
        throw "Bridge supervisor exited before the bridge became healthy. $details"
    }
    $managedHealth = Get-Json ($base + '/healthz')
    $managedBridgeId = 0
    if (Test-Path -LiteralPath $BridgePidFile) {
        [void][int]::TryParse((Get-Content -LiteralPath $BridgePidFile -Raw).Trim(), [ref]$managedBridgeId)
    }
    if ($managedHealth -and $managedHealth.ok -and $managedHealth.server -eq 'openclaw-chatgpt-bridge' -and $managedBridgeId -gt 0 -and [int]$managedHealth.pid -eq $managedBridgeId) { break }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $bridgeDeadline)

if (-not $managedHealth -or -not $managedHealth.ok -or $managedBridgeId -le 0 -or [int]$managedHealth.pid -ne $managedBridgeId) {
    $details = if (Test-Path -LiteralPath (Join-Path $LogDir 'bridge.stderr.log')) { (Get-Content (Join-Path $LogDir 'bridge.stderr.log') -Tail 30) -join [Environment]::NewLine } else { 'No bridge stderr log available.' }
    throw "Bridge supervisor did not produce a healthy managed bridge at $base within 45 seconds. $details"
}
Write-Host "MCP bridge supervised at $base (PID $managedBridgeId; supervisor PID $($supervisor.ProcessId))." -ForegroundColor Green

$ready = Get-Json ($tunnelHealth + '/readyz')
if ($ready -and (($ready -is [string] -and $ready.Trim() -eq 'ready') -or $ready.status -eq 'ready')) {
    Write-Host 'Tunnel client is already ready.' -ForegroundColor Green
} else {
    if (Test-Port ([int]$Cfg.tunnelHealthPort)) { throw "Tunnel health port $($Cfg.tunnelHealthPort) is occupied but is not reporting ready. Resolve the conflict or update setup." }
    Write-Host 'Starting Secure MCP Tunnel client ...'
    if ([string]::IsNullOrWhiteSpace($tunnelApiKey)) {
        $credentialTarget = if ([string]::IsNullOrWhiteSpace([string]$Cfg.credentialTarget)) { $DefaultCredentialTarget } else { [string]$Cfg.credentialTarget }
        $tunnelApiKey = [OpenClawBridge.WindowsCredentialStore]::Load($credentialTarget)
    }
    if ([string]::IsNullOrWhiteSpace($tunnelApiKey)) {
        throw 'The Secure MCP Tunnel API key is not available in Windows Credential Manager. Run npm run setup to store or migrate it before starting the tunnel.'
    }
    $out = Join-Path $LogDir 'tunnel-client.stdout.log'
    $err = Join-Path $LogDir 'tunnel-client.stderr.log'
    $profileArg = '"' + [string]$Cfg.tunnelProfilePath + '"'
    $tunnelArgs = 'run --config ' + $profileArg
    $previousApiKeyEnvironment = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
    try {
        $env:CONTROL_PLANE_API_KEY = $tunnelApiKey
        $proc = Start-LoggedProcess -FilePath ([string]$Cfg.tunnelClientPath) -Arguments $tunnelArgs -OutFile $out -ErrFile $err -WorkingDirectory $RepoRoot
    } finally {
        if ($null -eq $previousApiKeyEnvironment) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
        else { $env:CONTROL_PLANE_API_KEY = $previousApiKeyEnvironment }
        $tunnelApiKey = $null
    }
    Set-Content -LiteralPath $TunnelPidFile -Value $proc.Id -Encoding ASCII
    $ready = Wait-Json ($tunnelHealth + '/readyz') 45
    if (-not $ready -or -not (($ready -is [string] -and $ready.Trim() -eq 'ready') -or $ready.status -eq 'ready')) {
        $details = if (Test-Path $err) { (Get-Content $err -Tail 40) -join [Environment]::NewLine } else { 'No stderr log available.' }
        throw "Tunnel client did not become ready. See $err. $details"
    }
    Write-Host "Tunnel client started (PID $($proc.Id))." -ForegroundColor Green
}

Write-Host ''
Write-Host 'OpenClaw × ChatGPT is ready.' -ForegroundColor Green
Write-Host ('Overview: ' + $base + '/monitor')
Write-Host ('Health:   ' + $base + '/healthz')
Write-Host ('Logs:     ' + $LogDir)
if (-not $NoBrowser) { Start-Process ($base + '/monitor') }
