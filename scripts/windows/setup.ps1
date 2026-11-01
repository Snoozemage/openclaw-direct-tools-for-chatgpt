[CmdletBinding()]
param(
    [string]$OpenClawConfigPath,
    [string]$OpenClawCliPath,
    [string]$NodePath,
    [string]$TunnelId,
    [int]$BridgePort = 19002,
    [int]$GatewayPort,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
$SecretDir = Join-Path $AppHome 'secrets'
$SecretFile = Join-Path $SecretDir 'control-plane-api-key.txt'
$CredentialTarget = 'OpenClawChatGPTBridge/CONTROL_PLANE_API_KEY'
. (Join-Path $PSScriptRoot 'credential-store.ps1')
$ProfileDir = Join-Path $AppHome 'tunnel-profiles'
$ProfileName = 'openclaw-chatgpt-bridge'
$ProfileFile = Join-Path $ProfileDir ($ProfileName + '.yaml')
$LogDir = Join-Path $AppHome 'logs'
$TunnelHealthPort = 8081

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Read-Default([string]$Prompt, [string]$Default) {
    if ([string]::IsNullOrWhiteSpace($Default)) { return (Read-Host $Prompt).Trim() }
    $answer = (Read-Host "$Prompt [$Default]").Trim()
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer
}
function Find-FirstFile([string[]]$Candidates) {
    foreach ($candidate in $Candidates) { if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Resolve-Path -LiteralPath $candidate).Path } }
    return $null
}
function Set-CurrentUserOnlyAcl([string]$Path, [bool]$IsDirectory = $false) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($IsDirectory) {
        & icacls.exe $Path /inheritance:r /grant:r "${identity}:(OI)(CI)F" /Q | Out-Null
    } else {
        & icacls.exe $Path /inheritance:r /grant:r "${identity}:F" /Q | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not set private file permissions on $Path (icacls exit $LASTEXITCODE)." }
}
function Save-ApiKey {
    Write-Host 'Paste the OpenAI runtime API key when prompted. Input is hidden and the key will not be printed.' -ForegroundColor Yellow
    $secure = Read-Host 'Runtime API key' -AsSecureString
    if ($secure.Length -lt 20) { $secure.Dispose(); throw 'The API key looks too short. No key was saved.' }
    $ptr = [IntPtr]::Zero
    $plain = $null
    try {
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim()
        if ($plain.Length -lt 20 -or $plain -match '\s') { throw 'The API key appears invalid; no key was saved.' }
        [OpenClawBridge.WindowsCredentialStore]::Save($CredentialTarget, $plain)
        $saved = [OpenClawBridge.WindowsCredentialStore]::Load($CredentialTarget)
        if ($saved -cne $plain) { throw 'Windows Credential Manager verification failed; the API key was not accepted as saved.' }
        Write-Host 'Runtime key saved and verified in Windows Credential Manager.' -ForegroundColor Green
        return $saved
    }
    finally {
        if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $secure.Dispose()
        $plain = $null
    }
}
function Remove-LegacyApiKeyFile {
    if (-not (Test-Path -LiteralPath $SecretFile -PathType Leaf)) { return }
    Remove-Item -LiteralPath $SecretFile -Force -ErrorAction Stop
    $legacyDirectory = Split-Path -Parent $SecretFile
    if (Test-Path -LiteralPath $legacyDirectory -PathType Container) {
        $remaining = @(Get-ChildItem -LiteralPath $legacyDirectory -Force)
        if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $legacyDirectory -Force -ErrorAction SilentlyContinue }
    }
    Write-Host 'Removed the legacy plaintext API-key file after verifying the Credential Manager entry.' -ForegroundColor Green
}
function Get-OpenAiTunnelClient([string]$ExistingPath) {
    if ($ExistingPath -and (Test-Path -LiteralPath $ExistingPath -PathType Leaf)) { return (Resolve-Path -LiteralPath $ExistingPath).Path }
    $localCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\OpenChatX\runtime\bin\tunnel-client.exe'),
        (Join-Path $AppHome 'bin\tunnel-client.exe')
    )
    $found = Find-FirstFile $localCandidates
    if ($found) { return $found }

    Write-Step 'Download the official OpenAI tunnel-client for this Windows architecture'
    $architecture = if ([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $downloadRoot = Join-Path $AppHome 'bin'
    New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $headers = @{ 'User-Agent' = 'openclaw-chatgpt-bridge-setup'; 'Accept' = 'application/vnd.github+json' }
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest' -Headers $headers -TimeoutSec 25
        $asset = $release.assets | Where-Object { $_.name -match ('^tunnel-client-' + [regex]::Escape($release.tag_name) + '-windows-' + $architecture + '\.zip$') } | Select-Object -First 1
        if (-not $asset) { throw "Could not find the official full-client Windows $architecture archive in release $($release.tag_name)." }
        $versionDir = Join-Path $downloadRoot $release.tag_name
        if (Test-Path -LiteralPath (Join-Path $versionDir 'tunnel-client.exe')) { return (Join-Path $versionDir 'tunnel-client.exe') }
        $zipPath = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.zip')
        try {
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -TimeoutSec 120
            $expectedHash = $null
            if ([string]$asset.digest -match '^sha256:([A-Fa-f0-9]{64})$') {
                $expectedHash = $Matches[1].ToUpperInvariant()
            } else {
                $checksumAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
                if ($checksumAsset) {
                    $checksumPath = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.sha256.txt')
                    try {
                        Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -TimeoutSec 30
                        $checksumText = Get-Content -LiteralPath $checksumPath -Raw
                        $checksumMatch = [regex]::Match($checksumText, '(?im)^([a-f0-9]{64})\s+\*?' + [regex]::Escape($asset.name) + '\s*$')
                        if ($checksumMatch.Success) { $expectedHash = $checksumMatch.Groups[1].Value.ToUpperInvariant() }
                    } finally { if (Test-Path $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force } }
                }
            }
            if (-not $expectedHash) { throw 'Could not find a published SHA-256 checksum for the downloaded tunnel-client archive.' }
            $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToUpperInvariant()
            if ($actualHash -ne $expectedHash) { throw 'The tunnel-client archive SHA-256 check failed. The archive will not be extracted.' }
            Write-Host 'Verified tunnel-client archive SHA-256 checksum.' -ForegroundColor Green
            $staging = Join-Path $downloadRoot ([guid]::NewGuid().ToString())
            New-Item -ItemType Directory -Path $staging | Out-Null
            Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force
            $binary = Get-ChildItem -LiteralPath $staging -Filter 'tunnel-client.exe' -File -Recurse | Select-Object -First 1
            if (-not $binary) { Remove-Item -LiteralPath $staging -Recurse -Force; throw 'The official release archive did not contain tunnel-client.exe.' }
            if (Test-Path $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
            Move-Item -LiteralPath $staging -Destination $versionDir
            $binaryRelative = $binary.FullName.Substring($staging.Length).TrimStart('\')
            return (Join-Path $versionDir $binaryRelative)
        }
        finally { if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force } }
    }
    catch {
        Write-Warning ('Automatic download failed: ' + $_.Exception.Message)
        $manualPath = Read-Host 'Download the full Windows archive from https://github.com/openai/tunnel-client/releases/latest, extract it, and enter the full path to tunnel-client.exe'
        if (-not (Test-Path -LiteralPath $manualPath -PathType Leaf)) { throw 'A valid tunnel-client.exe path is required.' }
        return (Resolve-Path -LiteralPath $manualPath).Path
    }
}

if ($ValidateOnly) {
    Write-Step 'Validate source architecture and project scripts without changing configuration'
    $validationScript = Join-Path $RepoRoot 'tests\check-syntax.ps1'
    if (-not (Test-Path -LiteralPath $validationScript -PathType Leaf)) {
        throw "Validation script not found: $validationScript"
    }
    & $validationScript
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $package = Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
    if ($package.engines.node -notmatch '22\.17') { throw 'package.json does not declare Node.js 22.17+.' }
    Write-Host 'PASS package metadata' -ForegroundColor Green
    exit 0
}

Write-Step 'Prepare local configuration directory'
New-Item -ItemType Directory -Force -Path $AppHome, $ProfileDir, $LogDir | Out-Null
$config = $null
if (Test-Path -LiteralPath $ConfigFile) {
    try { $config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json } catch { Write-Warning 'Existing local config is invalid; a new configuration will be generated.' }
}

$betaRoot = Join-Path $env:LOCALAPPDATA 'OpenClawBeta'
$discoveredConfig = Find-FirstFile @(
    $config.openclawConfigPath,
    (Join-Path $betaRoot 'state\openclaw.json'),
    (Join-Path $env:USERPROFILE '.openclaw\openclaw.json'),
    (Join-Path $env:USERPROFILE '.openclaw\state\openclaw.json'),
    (Join-Path $env:LOCALAPPDATA 'OpenClaw\state\openclaw.json')
)
if (-not $OpenClawConfigPath) { $OpenClawConfigPath = Read-Default 'Path to openclaw.json' $discoveredConfig }
if (-not (Test-Path -LiteralPath $OpenClawConfigPath -PathType Leaf)) { throw "OpenClaw config not found: $OpenClawConfigPath" }
$OpenClawConfigPath = (Resolve-Path -LiteralPath $OpenClawConfigPath).Path
$stateDir = Split-Path -Parent $OpenClawConfigPath
$openClawRoot = if ((Split-Path -Leaf $stateDir) -eq 'state') { Split-Path -Parent $stateDir } else { $stateDir }

$nodeCandidates = @(
    $config.nodePath,
    (Join-Path $openClawRoot 'runtime\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'OpenClawBeta\runtime\node.exe'),
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
)
$NodePath = if ($NodePath) { $NodePath } else { Find-FirstFile $nodeCandidates }
if (-not $NodePath) { $NodePath = Read-Host 'Full path to node.exe (Node.js 22.17 or newer)' }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node.js executable not found: $NodePath" }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersion = (& $NodePath --version 2>&1 | Out-String).Trim()
if ($nodeVersion -match '^v(\d+)\.(\d+)\.') {
    $nodeMajor = [int]$Matches[1]
    $nodeMinor = [int]$Matches[2]
} else {
    throw "Could not determine the Node.js version: $nodeVersion."
}
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 17)) { throw "Node.js 22.17+ is required; found $nodeVersion." }

$ripgrepCommand = if ($env:OPENCLAW_RIPGREP_PATH) {
    if (Test-Path -LiteralPath $env:OPENCLAW_RIPGREP_PATH -PathType Leaf) { Get-Item -LiteralPath $env:OPENCLAW_RIPGREP_PATH } else { $null }
} else {
    Get-Command rg.exe -ErrorAction SilentlyContinue
}
if (-not $ripgrepCommand) { throw 'ripgrep (rg.exe) is required. Install it and add it to PATH, or set OPENCLAW_RIPGREP_PATH to its full path.' }
$ripgrepPath = if ($ripgrepCommand.Source) { $ripgrepCommand.Source } else { $ripgrepCommand.FullName }
$ripgrepVersionOutput = (& $ripgrepPath --version 2>&1 | Out-String).Trim()
$ripgrepVersion = ($ripgrepVersionOutput -split '\r?\n')[0].Trim()
if ($LASTEXITCODE -ne 0 -or $ripgrepVersion -notmatch '^ripgrep ') { throw "Could not run ripgrep at $ripgrepPath." }
Write-Host "Using $ripgrepVersion at $ripgrepPath" -ForegroundColor Green

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { throw 'npm.cmd is required to install the bridge SDK dependencies. Install Node.js with npm and add it to PATH.' }
Write-Step 'Install bridge SDK dependencies'
Push-Location $RepoRoot
try {
    & $npmCommand.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

$globalNpmRoot = $null
try { $globalNpmRoot = (& $npmCommand.Source root -g 2>$null | Select-Object -Last 1).Trim() } catch { $globalNpmRoot = $null }
$cliCandidates = @(
    $config.openclawCliPath,
    $(if ($globalNpmRoot) { Join-Path $globalNpmRoot 'openclaw\openclaw.mjs' }),
    $(if ($globalNpmRoot) { Join-Path $globalNpmRoot 'openclaw\bin\openclaw.js' }),
    (Join-Path $openClawRoot 'app\node_modules\openclaw\openclaw.mjs'),
    (Join-Path $env:LOCALAPPDATA 'OpenClawBeta\app\node_modules\openclaw\openclaw.mjs'),
    (Join-Path $env:APPDATA 'npm\node_modules\openclaw\openclaw.mjs'),
    (Join-Path $env:APPDATA 'npm\node_modules\openclaw\bin\openclaw.js')
)
if (-not $OpenClawCliPath) { $OpenClawCliPath = Find-FirstFile $cliCandidates }
if (-not $OpenClawCliPath) { $OpenClawCliPath = Read-Host 'Full path to OpenClaw CLI JavaScript entry point (openclaw.mjs or openclaw.js)' }
if (-not (Test-Path -LiteralPath $OpenClawCliPath -PathType Leaf)) { throw "OpenClaw CLI entry point not found: $OpenClawCliPath" }
$OpenClawCliPath = (Resolve-Path -LiteralPath $OpenClawCliPath).Path

try { $openClawSettings = Get-Content -LiteralPath $OpenClawConfigPath -Raw | ConvertFrom-Json } catch { throw 'openclaw.json is not valid JSON.' }
$gatewayDefault = if ($GatewayPort -gt 0) { [string]$GatewayPort } elseif ($config.gatewayPort) { [string]$config.gatewayPort } elseif ($openClawSettings.gateway.port) { [string]$openClawSettings.gateway.port } else { '18789' }
$GatewayPort = [int](Read-Default 'OpenClaw Gateway port' $gatewayDefault)
$BridgePort = [int](Read-Default 'Local bridge port' $(if ($config.bridgePort) { [string]$config.bridgePort } else { [string]$BridgePort }))
if ($BridgePort -lt 1024 -or $BridgePort -gt 65535 -or $GatewayPort -lt 1 -or $GatewayPort -gt 65535) { throw 'Gateway and bridge ports must be valid TCP ports.' }

if (-not $TunnelId) { $TunnelId = Read-Default 'Secure MCP Tunnel ID' ([string]$config.tunnelId) }
if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]{8,}$') { throw 'Tunnel ID format is invalid. Expected an ID beginning with tunnel_.' }

Write-Step 'Locate the official Secure MCP Tunnel client'
$tunnelClientPath = Get-OpenAiTunnelClient ([string]$config.tunnelClientPath)
$clientVersion = (& $tunnelClientPath --version 2>&1 | Out-String).Trim()
Write-Host "Using $clientVersion at $tunnelClientPath"

$storedApiKey = [OpenClawBridge.WindowsCredentialStore]::Load($CredentialTarget)
$removeLegacyApiKeyFile = $false
if (Test-Path -LiteralPath $SecretFile -PathType Leaf) {
    $legacyApiKey = [IO.File]::ReadAllText($SecretFile).Trim()
    if ($legacyApiKey.Length -lt 20 -or $legacyApiKey -match '\s') {
        throw "The legacy plaintext key file is invalid and was preserved: $SecretFile. Resolve it manually before rerunning setup."
    }

    if ([string]::IsNullOrWhiteSpace($storedApiKey)) {
        [OpenClawBridge.WindowsCredentialStore]::Save($CredentialTarget, $legacyApiKey)
        $verifiedApiKey = [OpenClawBridge.WindowsCredentialStore]::Load($CredentialTarget)
        if ($verifiedApiKey -cne $legacyApiKey) { throw "Migration verification failed; the legacy plaintext key file was preserved: $SecretFile" }
        $storedApiKey = $verifiedApiKey
        Write-Host 'Migrated the legacy API key into Windows Credential Manager.' -ForegroundColor Green
        $removeLegacyApiKeyFile = $true
    } elseif ($storedApiKey -ceq $legacyApiKey) {
        $removeLegacyApiKeyFile = $true
    } else {
        $replaceStored = Read-Default 'Credential Manager contains a different key. Replace it with the legacy file key? (Y/N)' 'N'
        if ($replaceStored -match '^(?i)y(es)?$') {
            [OpenClawBridge.WindowsCredentialStore]::Save($CredentialTarget, $legacyApiKey)
            $verifiedApiKey = [OpenClawBridge.WindowsCredentialStore]::Load($CredentialTarget)
            if ($verifiedApiKey -cne $legacyApiKey) { throw "Credential Manager verification failed; the legacy plaintext key file was preserved: $SecretFile" }
            $storedApiKey = $verifiedApiKey
            $removeLegacyApiKeyFile = $true
        } else {
            $keepStored = Read-Default 'Keep the Credential Manager key and remove the legacy plaintext file? (Y/N)' 'N'
            if ($keepStored -match '^(?i)y(es)?$') {
                $removeLegacyApiKeyFile = $true
            } else {
                throw "The Credential Manager entry and legacy plaintext key differ. Neither was changed; resolve the mismatch and rerun setup. Legacy file: $SecretFile"
            }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($storedApiKey)) {
    $apiKey = Save-ApiKey
} else {
    $reuse = Read-Default 'Reuse the saved runtime API key from Windows Credential Manager? (Y/N)' 'Y'
    if ($reuse -match '^(?i)y(es)?$') { $apiKey = $storedApiKey } else { $apiKey = Save-ApiKey }
}
$storedApiKey = $null

Write-Step 'Generate Secure MCP Tunnel profile'
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
$previousApiKeyEnvironment = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
try {
    $env:CONTROL_PLANE_API_KEY = $apiKey
    & $tunnelClientPath init --profile $ProfileName --profile-dir $ProfileDir --tunnel-id $TunnelId --mcp-server-url "http://127.0.0.1:$BridgePort/mcp" --control-plane-api-key-ref 'env:CONTROL_PLANE_API_KEY' --health-listen-addr "127.0.0.1:$TunnelHealthPort" --force
    $initExit = $LASTEXITCODE
} finally {
    if ($null -eq $previousApiKeyEnvironment) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
    else { $env:CONTROL_PLANE_API_KEY = $previousApiKeyEnvironment }
}
if ($initExit -ne 0 -or -not (Test-Path -LiteralPath $ProfileFile)) { throw 'Could not create the tunnel-client profile.' }
if ($removeLegacyApiKeyFile) { Remove-LegacyApiKeyFile }

$newConfig = [ordered]@{
    schemaVersion = 1
    openclawHome = $openClawRoot
    openclawConfigPath = $OpenClawConfigPath
    openclawStateDir = $stateDir
    openclawCliPath = $OpenClawCliPath
    nodePath = $NodePath
    gatewayPort = $GatewayPort
    bridgePort = $BridgePort
    bridgeHost = '127.0.0.1'
    agentId = if ($config.agentId) { [string]$config.agentId } else { 'main' }
    tunnelId = $TunnelId
    tunnelClientPath = $tunnelClientPath
    tunnelProfilePath = $ProfileFile
    tunnelProfileDir = $ProfileDir
    tunnelHealthPort = $TunnelHealthPort
    credentialTarget = $CredentialTarget
    repoPath = $RepoRoot
    logDir = $LogDir
    configuredAt = (Get-Date).ToString('o')
}
$newConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigFile -Encoding UTF8
Set-CurrentUserOnlyAcl -Path $ConfigFile

Write-Step 'Validate local runtime configuration'
& $NodePath --check (Join-Path $RepoRoot 'src\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bridge JavaScript syntax check failed.' }
$previousApiKeyEnvironment = [Environment]::GetEnvironmentVariable('CONTROL_PLANE_API_KEY', 'Process')
try {
    $env:CONTROL_PLANE_API_KEY = $apiKey
    & $tunnelClientPath doctor --config $ProfileFile --control-plane.api-key 'env:CONTROL_PLANE_API_KEY' --explain
    $doctorExit = $LASTEXITCODE
} finally {
    if ($null -eq $previousApiKeyEnvironment) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
    else { $env:CONTROL_PLANE_API_KEY = $previousApiKeyEnvironment }
    $apiKey = $null
}
if ($doctorExit -ne 0) { Write-Warning 'tunnel-client doctor reported a problem; the local configuration was saved so it can be corrected with status.ps1 and the README troubleshooting section.' }

Write-Host "`nSetup saved. Local configuration: $ConfigFile" -ForegroundColor Green
Write-Host 'Next: run npm start to start the bridge and tunnel, then open the local Overview.' -ForegroundColor Green
Write-Host 'Optional: run npm run autostart:install to register automatic startup at Windows sign-in. Setup does not enable autostart.' -ForegroundColor Cyan
if ($doctorExit -ne 0) { exit $doctorExit }
