[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
$TaskName = 'OpenClaw Gateway (ChatGPT Bridge)'
$StopRequestFile = Join-Path $AppHome 'gateway-task.stop'
if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw 'Local bridge configuration was not found.' }
$cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { throw "Gateway task '$TaskName' is not registered." }
if ($task.State -ne 'Running') { throw "Gateway supervisor is not running (state=$($task.State)); refusing to stop an unmanaged Gateway process." }

Set-Content -LiteralPath $StopRequestFile -Value 'stop' -Encoding ASCII
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $TaskName
} while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
if ($task.State -eq 'Running') {
    throw 'Gateway supervisor did not process the stop request within 30 seconds. The stop marker was preserved for diagnosis.'
}

$port = [int]$cfg.gatewayPort
$deadline = (Get-Date).AddSeconds(10)
do {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($listener) { throw "Gateway stop was requested, but port $port is still listening (PID $($listener.OwningProcess)). Inspect gateway-task.log." }
Write-Host "OpenClaw Gateway stopped on port $port. The Gateway task remains registered for the next sign-in." -ForegroundColor Green
