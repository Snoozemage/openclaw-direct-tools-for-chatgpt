$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $repoRoot 'src'

$files = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.mjs')
if ($files.Count -eq 0) { throw "No .mjs source files found under $sourceRoot" }

foreach ($file in $files) {
    Write-Host ("Checking JavaScript syntax: " + $file.FullName)
    & node --check $file.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$scriptFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'scripts\windows') -Recurse -File -Filter '*.ps1'
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'tests') -Recurse -File -Filter '*.ps1'
)
foreach ($script in $scriptFiles) {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) {
        $parseErrors | ForEach-Object {
            Write-Error ("PowerShell syntax error in " + $script.FullName + " at line " + $_.Extent.StartLineNumber + ": " + $_.Message)
        }
        exit 1
    }
    Write-Host ("Checking PowerShell syntax: " + $script.FullName)
}

$legacyPaths = @(
    (Join-Path $sourceRoot 'tools\catalog-tools.mjs'),
    (Join-Path $sourceRoot 'tools\computer-tools.mjs'),
    (Join-Path $sourceRoot 'tools\gateway-tools.mjs')
)
$legacyFiles = @($legacyPaths | Where-Object { Test-Path -LiteralPath $_ })
if ($legacyFiles.Count -gt 0) {
    throw ("Obsolete tool modules remain after the architecture cleanup: " + ($legacyFiles -join ', '))
}
$legacyOpenClawDir = Join-Path $sourceRoot 'openclaw'
if (Test-Path -LiteralPath $legacyOpenClawDir) {
    throw ("The obsolete src/openclaw directory should not exist: " + $legacyOpenClawDir)
}
Write-Host 'Checking source architecture: obsolete tool modules and src/openclaw directory are absent.'

$startScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\start.ps1') -Raw
$stopScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\stop.ps1') -Raw
$serverScript = Get-Content -LiteralPath (Join-Path $sourceRoot 'server.mjs') -Raw
$supervisorScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\bridge-supervisor.ps1') -Raw
$gatewayTaskScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\gateway-task.ps1') -Raw
$autostartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\install-autostart.ps1') -Raw
$gatewayStopScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\stop-gateway.ps1') -Raw
$trayScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\tray-app.ps1') -Raw
$trayLauncherScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\tray-launcher.vbs') -Raw
$trayRestartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\restart-bridge.ps1') -Raw
$powerShellLauncherScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\powershell-hidden-launcher.vbs') -Raw
$gatewayStartValid = $startScript.Contains('independently managed OpenClaw Gateway') -and $startScript.Contains('gateway status --json') -and $startScript.Contains('rpc.ok')
$logonScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\start-on-logon.ps1') -Raw
$logonStartValid = $logonScript.Contains('autostart.log') -and $logonScript.Contains('param()') -and $logonScript.Contains('$maxAttempts = 2') -and $logonScript.Contains('Retrying in 20 seconds')
$gatewayStopValid = -not $stopScript.Contains('Stop-OwnedProcess -PidFile $GatewayPidFile') -and $stopScript.Contains('Gateway is independently managed')
$gatewayTaskValid = $gatewayTaskScript.Contains('OPENCLAW_STATE_DIR') -and $gatewayTaskScript.Contains('gateway run --port') -and $gatewayTaskScript.Contains('Get-GatewayListener') -and $gatewayTaskScript.Contains('gateway-task.stop') -and $autostartScript.Contains('OpenClaw Gateway (ChatGPT Bridge)') -and $autostartScript.Contains('$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user') -and -not $autostartScript.Contains('$bridgeTrigger.Delay') -and $autostartScript.Contains('Updated bridge task to start immediately at sign-in') -and $autostartScript.Contains('ExecutionTimeLimit ([TimeSpan]::Zero)') -and $gatewayStopScript.Contains('gateway-task.stop')
$trayTaskValid = $autostartScript.Contains('ChatGPT OpenClaw Direct Tools Tray') -and $autostartScript.Contains('wscript.exe') -and $autostartScript.Contains('tray-launcher.vbs') -and $trayLauncherScript.Contains('shell.Run(command, 0, True)') -and $trayLauncherScript.Contains('-WindowStyle Hidden') -and $trayScript.Contains('/startupz') -and $trayScript.Contains('/healthz') -and $trayScript.Contains('/readyz') -and $trayScript.Contains('NotifyIcon') -and $trayScript.Contains('Restart Bridge') -and $trayScript.Contains('$script:ConfigLastWriteUtc') -and $trayScript.Contains('$script:Timer.Interval = 3500') -and -not $trayScript.Contains('RefreshItem') -and -not $trayScript.Contains('Refresh status') -and $trayRestartScript.Contains('stop.ps1') -and $trayRestartScript.Contains('start.ps1')
$bridgeSupervisorValid = $startScript.Contains('bridge-supervisor.ps1') -and $supervisorScript.Contains('OPENCLAW_BRIDGE_SUPERVISED') -and $supervisorScript.Contains('health.pid') -and $supervisorScript.Contains('restarting the bridge only') -and $stopScript.Contains('Stop-BridgeSupervisor')
$bridgeRestartValid = $serverScript.Contains('OPENCLAW_BRIDGE_SUPERVISED') -and -not $serverScript.Contains('restart-bridge.ps1') -and -not $serverScript.Contains('spawn("powershell.exe"')
if (-not $gatewayStartValid) { throw 'Gateway readiness contract failed: start.ps1 must wait for the independent Gateway RPC readiness and must not launch it.' }
if (-not $logonStartValid) { throw 'Logon startup contract failed: start-on-logon.ps1 must log startup output and retry one failed attempt.' }
if (-not $gatewayStopValid) { throw 'Gateway ownership contract failed: stop.ps1 must leave the independently managed Gateway running.' }
if (-not $gatewayTaskValid) { throw 'Startup task contract failed: the Gateway must have an independent lifecycle and the bridge task must start at sign-in without an artificial delay.' }
if (-not $trayTaskValid) { throw 'Tray companion contract failed: a separate logon task must display status from the Gateway, MCP bridge, and tunnel health endpoints and support bridge restart.' }
if (-not $bridgeSupervisorValid -or -not $bridgeRestartValid) { throw 'Bridge lifecycle contract failed: Monitor restart must exit the supervised bridge and let its external supervisor restart only that child.' }
Write-Host 'Checking lifecycle contract: independent Gateway task, RPC readiness gate, immediate bridge startup, tray companion, bridge supervisor restart, and ownership-aware stop are present.'

$setupScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\setup.ps1') -Raw
$packageManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$setupAutostartValid = -not $setupScript.Contains('install-autostart.ps1') -and $setupScript.Contains('npm run autostart:install') -and $packageManifest.scripts.'autostart:install'
if (-not $setupAutostartValid) { throw 'Autostart opt-in contract failed: setup.ps1 must not register Scheduled Tasks; users must explicitly run npm run autostart:install.' }
$bridgeTaskHiddenValid = $autostartScript.Contains('$gatewayAction = New-ScheduledTaskAction -Execute $WindowsScriptHost') -and $autostartScript.Contains('$bridgeAction = New-ScheduledTaskAction -Execute $WindowsScriptHost') -and $autostartScript.Contains('$PowerShellLauncherScript') -and $powerShellLauncherScript.Contains('shell.Run(command, 0, True)') -and $powerShellLauncherScript.Contains('-WindowStyle Hidden') -and $autostartScript.Contains('Set-ScheduledTask -TaskName $BridgeTaskName -Action $bridgeAction -Trigger $bridgeTrigger')
if (-not $bridgeTaskHiddenValid) { throw 'Startup task console contract failed: Gateway and bridge tasks must use the hidden Windows Script Host PowerShell launcher.' }
$gatewayAdoptionValid = $gatewayTaskScript.Contains('$rpcReady = $false') -and $gatewayTaskScript.Contains('if (-not $rpcReady)') -and $gatewayTaskScript.Contains('explicit Gateway stop request')
if (-not $gatewayAdoptionValid) { throw 'Gateway adoption contract failed: reuse the successful RPC readiness result and log stop ownership accurately.' }
$credentialModule = Join-Path $repoRoot 'scripts\windows\credential-store.ps1'
$credentialInterop = Join-Path $repoRoot 'scripts\windows\WindowsCredentialStore.cs'
$credentialStorageValid = (Test-Path -LiteralPath $credentialModule) -and
    (Test-Path -LiteralPath $credentialInterop) -and
    $setupScript.Contains('WindowsCredentialStore]::Save') -and
    $setupScript.Contains("--control-plane-api-key-ref 'env:CONTROL_PLANE_API_KEY'") -and
    -not $setupScript.Contains('WriteAllText($SecretFile') -and
    -not $setupScript.Contains('file:$SecretFile') -and
    $startScript.Contains('WindowsCredentialStore]::Load') -and
    $startScript.Contains('$env:CONTROL_PLANE_API_KEY = $tunnelApiKey') -and
    -not $startScript.Contains('apiKeyPath') -and
    -not $startScript.Contains('--control-plane.api-key')
if (-not $credentialStorageValid) {
    throw 'Credential storage contract failed: setup/start must use Windows Credential Manager and env:CONTROL_PLANE_API_KEY without writing or requiring a plaintext API-key file.'
}
Write-Host 'Checking credential contract: API key is stored in Windows Credential Manager and passed through the tunnel-client process environment.'

Write-Host ("All checks passed: " + $files.Count + " JavaScript module(s), " + $scriptFiles.Count + " PowerShell script(s).")
