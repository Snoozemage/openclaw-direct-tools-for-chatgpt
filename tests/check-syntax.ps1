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
$bridgeRestartSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'bridge-restart.mjs') -Raw
$bridgeSupervisorScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\bridge-supervisor.ps1') -Raw
$gatewayTaskScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\gateway-task.ps1') -Raw
$serviceSupervisorScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\service-supervisor.ps1') -Raw
$serviceStartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\service-start.ps1') -Raw
$serviceStopScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\service-stop.ps1') -Raw
$startupLauncherSource = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\startup-launcher.cs') -Raw
$autostartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\install-autostart.ps1') -Raw
$uninstallAutostartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\uninstall-autostart.ps1') -Raw
$trayScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\tray-app.ps1') -Raw
$trayLauncherScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\tray-launcher.vbs') -Raw
$trayRestartScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\restart-bridge.ps1') -Raw
$gatewayStartValid = $startScript.Contains('central service supervisor') -and $startScript.Contains('gateway status --json') -and $startScript.Contains('rpc.ok')
$serviceSupervisorValid = $serviceSupervisorScript.Contains('gateway-task.ps1') -and $serviceSupervisorScript.Contains('start.ps1') -and $serviceSupervisorScript.Contains('tray-launcher.vbs') -and $serviceSupervisorScript.Contains('service.stop') -and $serviceSupervisorScript.Contains('Test-BridgeHealthy') -and $serviceSupervisorScript.Contains('Test-TunnelReady') -and $serviceSupervisorScript.Contains('Import-UserEnvironment') -and $serviceSupervisorScript.Contains("GetEnvironmentVariable('Path', 'User')") -and -not $serviceSupervisorScript.Contains('OPENCLAW_RIPGREP_PATH') -and -not $serviceSupervisorScript.Contains('Add-Type -TypeDefinition') -and -not $serviceSupervisorScript.Contains('OpenClawDirectToolsJob') -and $serviceSupervisorScript.Contains('Supervisor loop iteration failed')
$serviceLifecycleValid = $serviceStartScript.Contains('OpenClaw Direct Tools.exe') -and $serviceStartScript.Contains('service.pid') -and $serviceStopScript.Contains('service.stop') -and $serviceStopScript.Contains('service-supervisor.ps1')
$singleStartupValid = $autostartScript.Contains("[Environment]::GetFolderPath('Startup')") -and $autostartScript.Contains('OpenClaw Direct Tools.lnk') -and $autostartScript.Contains('CreateShortcut') -and $autostartScript.Contains('IconLocation') -and $autostartScript.Contains('openclaw-direct-tools.ico') -and $autostartScript.Contains('Remove-ItemProperty') -and $autostartScript.Contains('Unregister-ScheduledTask') -and -not $autostartScript.Contains('New-ItemProperty') -and $uninstallAutostartScript.Contains('OpenClaw Direct Tools.lnk') -and $uninstallAutostartScript.Contains('Remove-ItemProperty')
$trayControlValid = $trayScript.Contains('/startupz') -and $trayScript.Contains('/healthz') -and $trayScript.Contains('/readyz') -and $trayScript.Contains('/api/activity') -and $trayScript.Contains('ActivityTimer.Interval = 500') -and $trayScript.Contains("'tool'") -and $trayScript.Contains("'computer'") -and $trayScript.Contains('NotifyIcon') -and $trayScript.Contains('Restart Bridge') -and $trayScript.Contains('Stop OpenClaw Direct Tools') -and $trayScript.Contains('service.stop') -and $trayScript.Contains('tray.disabled') -and $trayScript.Contains('$script:Timer.Interval = 3500') -and $trayScript.Contains('OpenClawDirectToolsNativeMethods') -and $trayScript.Contains('DestroyIconMethod.Invoke') -and -not $trayScript.Contains('Add-Type -TypeDefinition') -and $trayLauncherScript.Contains('shell.Run(command, 0, True)') -and $trayRestartScript.Contains('stop.ps1') -and $trayRestartScript.Contains('start.ps1')
$gatewayTaskValid = $gatewayTaskScript.Contains('OPENCLAW_STATE_DIR') -and $gatewayTaskScript.Contains('gateway run --port') -and $gatewayTaskScript.Contains('Get-GatewayListener') -and $gatewayTaskScript.Contains('gateway-task.stop') -and $serviceSupervisorScript.Contains('$GatewayScript')
$bridgeSupervisorValid = $startScript.Contains('bridge-supervisor.ps1') -and $bridgeSupervisorScript.Contains('OPENCLAW_BRIDGE_SUPERVISED') -and $bridgeSupervisorScript.Contains('health.pid') -and $bridgeSupervisorScript.Contains('restarting the bridge only') -and $stopScript.Contains('Stop-BridgeSupervisor')
$bridgeRestartValid = $serverScript.Contains('bridgeRestart.request()') -and $serverScript.Contains('bridgeRestart.bindShutdown(shutdown)') -and $bridgeRestartSource.Contains('OPENCLAW_BRIDGE_SUPERVISED === "1"') -and $bridgeRestartSource.Contains('schedule(shutdown)') -and -not $serverScript.Contains('restart-bridge.ps1') -and -not $serverScript.Contains('spawn("powershell.exe"')
if (-not $gatewayStartValid -or -not $gatewayTaskValid) { throw 'Gateway readiness contract failed: the central supervisor must own gateway-task.ps1 and start.ps1 must wait for Gateway RPC readiness.' }
if (-not $serviceSupervisorValid -or -not $serviceLifecycleValid) { throw 'Central lifecycle contract failed: one supervisor must own Gateway, bridge, tunnel, tray, and coordinated shutdown.' }
if (-not $singleStartupValid) { throw 'Startup UX contract failed: install-autostart.ps1 must create one branded Startup-folder shortcut, remove the legacy Registry Run entry, and uninstall both registrations.' }
if (-not $trayControlValid) { throw 'Tray control contract failed: status, bridge restart, full service stop, and tray-only exit must be available.' }
if (-not $bridgeSupervisorValid -or -not $bridgeRestartValid) { throw 'Bridge lifecycle contract failed: Monitor and MCP restart must delegate bridge process replacement to the supervisor.' }
Write-Host 'Checking lifecycle contract: one branded Startup-folder shortcut, central process supervisor, coordinated Gateway/bridge/tunnel/tray shutdown, and tray controls are present.'

$setupScript = Get-Content -LiteralPath (Join-Path $repoRoot 'scripts\windows\setup.ps1') -Raw
$packageManifest = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$setupAutostartValid = -not $setupScript.Contains('install-autostart.ps1') -and $setupScript.Contains('npm run autostart:install') -and $packageManifest.scripts.'autostart:install'
if (-not $setupAutostartValid) { throw 'Autostart opt-in contract failed: setup.ps1 must not register Scheduled Tasks; users must explicitly run npm run autostart:install.' }
$startupLauncherValid = $startupLauncherSource.Contains('[assembly: AssemblyTitle("OpenClaw Direct Tools")]') -and $startupLauncherSource.Contains('[assembly: AssemblyProduct("OpenClaw Direct Tools for ChatGPT")]') -and $startupLauncherSource.Contains('[assembly: AssemblyCompany("Snoozemage")]') -and $startupLauncherSource.Contains('service-supervisor.ps1') -and $startupLauncherSource.Contains('CreateNoWindow = true') -and $startupLauncherSource.Contains('WaitForExit()') -and $startupLauncherSource.Contains('CreateJobObject') -and $startupLauncherSource.Contains('SetInformationJobObject') -and $startupLauncherSource.Contains('AssignProcessToJobObject') -and $startupLauncherSource.Contains('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE') -and $startupLauncherSource.Contains('OpenClawDirectToolsNativeMethods') -and $autostartScript.Contains('startup-launcher.cs') -and $autostartScript.Contains('WindowsCredentialStore.cs') -and $autostartScript.Contains('$CredentialStoreSource') -and $autostartScript.Contains('/target:winexe') -and $autostartScript.Contains('/win32icon:') -and $autostartScript.Contains('C# compiler not found; using the bundled startup launcher executable.') -and $autostartScript.Contains('bundled startup launcher is missing') -and $autostartScript.Contains('OpenClaw Direct Tools.exe') -and $autostartScript.Contains('openclaw-direct-tools.ico') -and (Test-Path -LiteralPath (Join-Path $repoRoot 'assets\openclaw-direct-tools.ico')) -and (Test-Path -LiteralPath (Join-Path $repoRoot 'assets\OpenClaw Direct Tools.exe')) -and $packageManifest.scripts.start.Contains('service-start.ps1')
if (-not $startupLauncherValid) { throw 'Startup launcher contract failed: the native WinExe must embed the project name and icon, then start the central service supervisor without a console window.' }
$gatewayAdoptionValid = $gatewayTaskScript.Contains('Get-GatewayListener') -and $gatewayTaskScript.Contains('central start.ps1 gate validates RPC readiness') -and -not $gatewayTaskScript.Contains('Test-GatewayRpc')
if (-not $gatewayAdoptionValid) { throw 'Gateway ownership contract failed: the Gateway worker must monitor a verified listener and leave RPC readiness to the central start.ps1 gate.' }
$obsoleteLifecycleFiles = @('start-on-logon.ps1', 'start-monitor.ps1', 'powershell-hidden-launcher.vbs', 'service-launcher.vbs', 'stop-gateway.ps1')
$obsoleteLifecycleFilesPresent = @($obsoleteLifecycleFiles | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot ('scripts\windows\' + $_)) })
$packageScriptNames = @($packageManifest.scripts.PSObject.Properties.Name)
$obsoletePackageAliases = @('service:start', 'service:stop', 'gateway:stop')
$obsoletePackageAliasesPresent = @($obsoletePackageAliases | Where-Object { $_ -in $packageScriptNames })
if ($obsoleteLifecycleFilesPresent.Count -gt 0 -or $obsoletePackageAliasesPresent.Count -gt 0) {
    throw ('Redundant lifecycle entry points remain. Files: ' + ($obsoleteLifecycleFilesPresent -join ', ') + '; npm aliases: ' + ($obsoletePackageAliasesPresent -join ', '))
}
$credentialModule = Join-Path $repoRoot 'scripts\windows\credential-store.ps1'
$credentialModuleSource = Get-Content -LiteralPath $credentialModule -Raw
$credentialInterop = Join-Path $repoRoot 'scripts\windows\WindowsCredentialStore.cs'
$credentialStorageValid = (Test-Path -LiteralPath $credentialModule) -and
    (Test-Path -LiteralPath $credentialInterop) -and
    $credentialModuleSource.Contains('[Reflection.Assembly]::LoadFrom') -and
    -not $credentialModuleSource.Contains('Add-Type -Path') -and
    $autostartScript.Contains('$CredentialStoreSource') -and
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
