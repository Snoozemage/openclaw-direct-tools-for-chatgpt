[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge\logs'

if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
    Write-Host "No bridge logs found at $logDir"
    exit 0
}

$files = @(Get-ChildItem -LiteralPath $logDir -File -Filter '*.log' |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First 5)
if ($files.Count -eq 0) {
    Write-Host "No log files in $logDir"
    exit 0
}

foreach ($file in $files) {
    Write-Host ("--- " + $file.Name + " ---")
    Get-Content -LiteralPath $file.FullName -Tail 100
}
