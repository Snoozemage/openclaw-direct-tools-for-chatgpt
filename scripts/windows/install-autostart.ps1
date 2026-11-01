[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$GatewayTaskName = 'OpenClaw Gateway (ChatGPT Bridge)'
$BridgeTaskName = 'ChatGPT OpenClaw Direct Tools AutoStart'
$TrayTaskName = 'ChatGPT OpenClaw Direct Tools Tray'
$PowerShell = Join-Path $PSHOME 'powershell.exe'
$GatewayScript = Join-Path $PSScriptRoot 'gateway-task.ps1'
$BridgeScript = Join-Path $PSScriptRoot 'start-on-logon.ps1'
$TrayScript = Join-Path $PSScriptRoot 'tray-app.ps1'
$TrayLauncherScript = Join-Path $PSScriptRoot 'tray-launcher.vbs'
$PowerShellLauncherScript = Join-Path $PSScriptRoot 'powershell-hidden-launcher.vbs'
$WindowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$WindowsScriptHost = Join-Path $env:WINDIR 'System32\wscript.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($path in @($GatewayScript, $BridgeScript, $TrayScript, $TrayLauncherScript, $PowerShellLauncherScript, $WindowsPowerShell, $WindowsScriptHost)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Startup script not found: $path" }
}

$gatewayAction = New-ScheduledTaskAction -Execute $WindowsScriptHost -Argument ('"' + $PowerShellLauncherScript + '" "' + $GatewayScript + '"') -WorkingDirectory $RepoRoot
$gatewayTask = Get-ScheduledTask -TaskName $GatewayTaskName -ErrorAction SilentlyContinue
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$gatewayTaskMigrated = $false
if ($gatewayTask) {
    $existingGatewayAction = $gatewayTask.Actions | Select-Object -First 1
    $gatewayUsesCurrentLauncher = $existingGatewayAction -and $existingGatewayAction.Execute -ieq $WindowsScriptHost -and $existingGatewayAction.Arguments -like ('*' + $PowerShellLauncherScript + '*') -and $existingGatewayAction.Arguments -like ('*' + $GatewayScript + '*')
    $gatewayUsesLegacyPowerShell = $existingGatewayAction -and $existingGatewayAction.Execute -ieq $PowerShell -and $existingGatewayAction.Arguments -like ('*' + $GatewayScript + '*')
    if (-not $gatewayUsesCurrentLauncher -and -not $gatewayUsesLegacyPowerShell) {
        throw "Existing task '$GatewayTaskName' does not match a known Gateway supervisor action. It was left unchanged."
    }
    if ($gatewayUsesLegacyPowerShell) {
        Set-ScheduledTask -TaskName $GatewayTaskName -Action $gatewayAction | Out-Null
        $gatewayTaskMigrated = $true
        Write-Host "Updated Gateway task to use the hidden Windows Script Host launcher: $GatewayTaskName" -ForegroundColor Green
    }
} else {
    $gatewayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $gatewaySettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $GatewayTaskName -Action $gatewayAction -Trigger $gatewayTrigger -Settings $gatewaySettings -Principal $principal -Description 'Owns the OpenClaw Gateway process for the ChatGPT Direct Tools bridge profile.' -Force | Out-Null
}
if ($gatewayTaskMigrated) {
    Start-ScheduledTask -TaskName $GatewayTaskName
    Write-Host "Restarted the Gateway supervisor through its hidden launcher: $GatewayTaskName" -ForegroundColor Green
}

$bridgeAction = New-ScheduledTaskAction -Execute $WindowsScriptHost -Argument ('"' + $PowerShellLauncherScript + '" "' + $BridgeScript + '"') -WorkingDirectory $RepoRoot
$bridgeTask = Get-ScheduledTask -TaskName $BridgeTaskName -ErrorAction SilentlyContinue
$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$bridgeSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($bridgeTask) {
    $existingBridgeAction = $bridgeTask.Actions | Select-Object -First 1
    $bridgeUsesCurrentLauncher = $existingBridgeAction -and $existingBridgeAction.Execute -ieq $WindowsScriptHost -and $existingBridgeAction.Arguments -like ('*' + $PowerShellLauncherScript + '*') -and $existingBridgeAction.Arguments -like ('*' + $BridgeScript + '*')
    $bridgeUsesLegacyPowerShell = $existingBridgeAction -and $existingBridgeAction.Execute -ieq $PowerShell -and $existingBridgeAction.Arguments -like ('*' + $BridgeScript + '*')
    if (-not $bridgeUsesCurrentLauncher -and -not $bridgeUsesLegacyPowerShell) {
        throw "Existing task '$BridgeTaskName' does not match a known bridge startup action. It was left unchanged."
    }
    Set-ScheduledTask -TaskName $BridgeTaskName -Action $bridgeAction -Trigger $bridgeTrigger -Settings $bridgeSettings -Principal $principal | Out-Null
    if ($bridgeUsesLegacyPowerShell) {
        Write-Host "Updated bridge task to use the hidden Windows Script Host launcher: $BridgeTaskName" -ForegroundColor Green
    }
    Write-Host "Updated bridge task to start immediately at sign-in: $BridgeTaskName" -ForegroundColor Green
} else {
    Register-ScheduledTask -TaskName $BridgeTaskName -Action $bridgeAction -Trigger $bridgeTrigger -Settings $bridgeSettings -Principal $principal -Description 'Starts the ChatGPT MCP bridge and Secure MCP Tunnel after the Gateway is available.' -Force | Out-Null
}

$trayAction = New-ScheduledTaskAction -Execute $WindowsScriptHost -Argument ('"' + $TrayLauncherScript + '"') -WorkingDirectory $RepoRoot
$trayTask = Get-ScheduledTask -TaskName $TrayTaskName -ErrorAction SilentlyContinue
if ($trayTask) {
    $existingTrayAction = $trayTask.Actions | Select-Object -First 1
    $isCurrentLauncher = $existingTrayAction -and $existingTrayAction.Execute -ieq $WindowsScriptHost -and $existingTrayAction.Arguments -like ('*' + $TrayLauncherScript + '*')
    $isLegacyLauncher = $existingTrayAction -and $existingTrayAction.Execute -ieq $WindowsPowerShell -and $existingTrayAction.Arguments -like ('*' + $TrayScript + '*')
    if (-not $isCurrentLauncher -and -not $isLegacyLauncher) {
        throw "Existing task '$TrayTaskName' does not match a known tray launcher. It was left unchanged."
    }
    if ($isLegacyLauncher) {
        if ($trayTask.State -eq 'Running') {
            throw "Tray task '$TrayTaskName' is running. Stop it before switching to the console-free launcher."
        }
        Set-ScheduledTask -TaskName $TrayTaskName -Action $trayAction | Out-Null
        Write-Host "Updated tray task to use a console-free Windows Script Host launcher: $TrayTaskName" -ForegroundColor Green
    }
} else {
    $trayTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $traySettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TrayTaskName -Action $trayAction -Trigger $trayTrigger -Settings $traySettings -Principal $principal -Description 'Displays live Gateway, bridge, and Secure MCP Tunnel status in the Windows notification area using a console-free launcher.' -Force | Out-Null
}

if ((Get-ScheduledTask -TaskName $TrayTaskName).State -ne 'Running') {
    Start-ScheduledTask -TaskName $TrayTaskName
}

Write-Host "Registered independent Gateway task: $GatewayTaskName" -ForegroundColor Green
Write-Host "Configured bridge startup to begin immediately at sign-in: $BridgeTaskName" -ForegroundColor Green
Write-Host "Started tray companion: $TrayTaskName" -ForegroundColor Green
Write-Host 'Gateway, bridge, and tray companion have separate Scheduled Task lifecycles; PowerShell tasks use hidden Windows Script Host launchers.' -ForegroundColor Cyan
