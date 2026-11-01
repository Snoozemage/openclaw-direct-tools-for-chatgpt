[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
$LogDir = Join-Path $AppHome 'logs'
$LogFile = Join-Path $LogDir 'tray.log'
$RestartScript = Join-Path $PSScriptRoot 'restart-bridge.ps1'
$ServiceStopScript = Join-Path $PSScriptRoot 'service-stop.ps1'
$ServiceStopFile = Join-Path $AppHome 'service.stop'
$TrayDisabledFile = Join-Path $AppHome 'tray.disabled'

$script:Cfg = $null
$script:ConfigLastWriteUtc = $null
$script:MonitorUrl = $null
$script:StartedAt = Get-Date
$script:StartupGraceUntil = $script:StartedAt.AddMinutes(5)
$script:EverReady = $false
$script:ReadyWasShown = $false
$script:RestartUntil = $null
$script:LastState = $null

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-TrayLog([string]$Message) {
    $entry = '[' + (Get-Date).ToString('o') + '] ' + $Message + [Environment]::NewLine
    [IO.File]::AppendAllText($LogFile, $entry, [Text.UTF8Encoding]::new($false))
}

function Get-Json([string]$Url) {
    try { Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2 -ErrorAction Stop }
    catch { $null }
}

function Get-ComponentStatus {
    $status = [ordered]@{
        Configured = ($null -ne $script:Cfg)
        Gateway = $false
        Bridge = $false
        Tunnel = $false
    }
    if ($null -eq $script:Cfg) { return [pscustomobject]$status }

    # /startupz is OpenClaw's lightweight startup-admission probe; avoid the slow CLI status command.
    $gateway = Get-Json ('http://127.0.0.1:' + [int]$script:Cfg.gatewayPort + '/startupz')
    $status.Gateway = [bool]($gateway -and $gateway.ok -and $gateway.status -eq 'started')

    $bridge = Get-Json ('http://127.0.0.1:' + [int]$script:Cfg.bridgePort + '/healthz')
    $status.Bridge = [bool]($bridge -and $bridge.ok -and $bridge.server -eq 'openclaw-chatgpt-bridge')

    $tunnel = Get-Json ('http://127.0.0.1:' + [int]$script:Cfg.tunnelHealthPort + '/readyz')
    $status.Tunnel = [bool]($tunnel -and (($tunnel -is [string] -and $tunnel.Trim() -eq 'ready') -or $tunnel.status -eq 'ready'))

    return [pscustomobject]$status
}

function New-StatusIcon([Drawing.Color]$Color) {
    $bitmap = [Drawing.Bitmap]::new(32, 32)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $brush = [Drawing.SolidBrush]::new($Color)
    $border = [Drawing.Pen]::new([Drawing.Color]::White, 2)
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.FillEllipse($brush, 3, 3, 26, 26)
        $graphics.DrawEllipse($border, 3, 3, 26, 26)
        $handle = $bitmap.GetHicon()
        return [pscustomobject]@{
            Icon = [Drawing.Icon]::FromHandle($handle)
            Handle = $handle
        }
    } finally {
        $border.Dispose()
        $brush.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Set-TrayState([string]$State, $Components) {
    if ($State -eq 'READY') { $iconKey = 'Ready' }
    elseif ($State -eq 'OFFLINE' -or $State -eq 'CONFIG MISSING') { $iconKey = 'Offline' }
    else { $iconKey = 'Pending' }

    $script:NotifyIcon.Icon = $script:Icons[$iconKey].Icon
    $script:NotifyIcon.Text = 'OpenClaw Direct Tools: ' + $State
    $script:StateItem.Text = 'Status: ' + $State
    $script:GatewayItem.Text = 'Gateway: ' + $(if ($Components.Configured -and $Components.Gateway) { 'Started' } elseif ($Components.Configured) { 'Not ready' } else { 'Unknown' })
    $script:BridgeItem.Text = 'MCP Bridge: ' + $(if ($Components.Configured -and $Components.Bridge) { 'Healthy' } elseif ($Components.Configured) { 'Not ready' } else { 'Unknown' })
    $script:TunnelItem.Text = 'Secure MCP Tunnel: ' + $(if ($Components.Configured -and $Components.Tunnel) { 'Ready' } elseif ($Components.Configured) { 'Not ready' } else { 'Unknown' })
    $script:RestartItem.Enabled = -not ($null -ne $script:RestartUntil -and (Get-Date) -lt $script:RestartUntil)

    if ($State -ne $script:LastState) {
        Write-TrayLog ('State changed: ' + $State + '; Gateway=' + $Components.Gateway + '; Bridge=' + $Components.Bridge + '; Tunnel=' + $Components.Tunnel)
        $script:LastState = $State
    }
}

function Update-TrayStatus {
    if (Test-Path -LiteralPath $ServiceStopFile) {
        Write-TrayLog 'Central service shutdown requested.'
        [Windows.Forms.Application]::Exit()
        return
    }

    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
        $script:Cfg = $null
        $script:ConfigLastWriteUtc = $null
        $script:MonitorUrl = $null
        Set-TrayState 'CONFIG MISSING' ([pscustomobject]@{ Configured = $false; Gateway = $false; Bridge = $false; Tunnel = $false })
        $script:ReadyWasShown = $false
        return
    }

    try {
        $configInfo = Get-Item -LiteralPath $ConfigFile -ErrorAction Stop
        if ($null -eq $script:Cfg -or $null -eq $script:ConfigLastWriteUtc -or $script:ConfigLastWriteUtc -ne $configInfo.LastWriteTimeUtc) {
            $candidateConfig = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json -ErrorAction Stop
            foreach ($key in @('gatewayPort', 'bridgePort', 'tunnelHealthPort')) {
                $port = 0
                if (-not [int]::TryParse([string]$candidateConfig.$key, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                    throw "Local config has an invalid '$key' value."
                }
            }
            $script:Cfg = $candidateConfig
            $script:ConfigLastWriteUtc = $configInfo.LastWriteTimeUtc
            $script:MonitorUrl = 'http://127.0.0.1:' + [int]$script:Cfg.bridgePort + '/monitor'
            Write-TrayLog 'Loaded or reloaded local configuration.'
        }
    } catch {
        $script:Cfg = $null
        $script:ConfigLastWriteUtc = (Get-Item -LiteralPath $ConfigFile -ErrorAction SilentlyContinue).LastWriteTimeUtc
        $script:MonitorUrl = $null
        Write-TrayLog ('Configuration error: ' + $_.Exception.Message)
        Set-TrayState 'CONFIG MISSING' ([pscustomobject]@{ Configured = $false; Gateway = $false; Bridge = $false; Tunnel = $false })
        $script:ReadyWasShown = $false
        return
    }

    $components = Get-ComponentStatus
    $allReady = $components.Gateway -and $components.Bridge -and $components.Tunnel
    $anyReady = $components.Gateway -or $components.Bridge -or $components.Tunnel

    if ($allReady) {
        $state = 'READY'
        $script:EverReady = $true
        $script:RestartUntil = $null
    } elseif ($null -ne $script:RestartUntil -and (Get-Date) -lt $script:RestartUntil) {
        $state = 'RESTARTING'
    } elseif (-not $script:EverReady -and (Get-Date) -lt $script:StartupGraceUntil) {
        $state = 'STARTING'
    } elseif ($anyReady) {
        $state = 'PARTIAL'
    } else {
        $state = 'OFFLINE'
    }

    Set-TrayState $state $components

    if ($allReady -and -not $script:ReadyWasShown) {
        $script:NotifyIcon.BalloonTipTitle = 'OpenClaw Direct Tools is ready'
        $script:NotifyIcon.BalloonTipText = 'Gateway, MCP Bridge and Secure MCP Tunnel are all healthy.'
        $script:NotifyIcon.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Info
        $script:NotifyIcon.ShowBalloonTip(3500)
    }
    $script:ReadyWasShown = [bool]$allReady
}

if (-not ('ChatGPTDirectToolsTrayNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ChatGPTDirectToolsTrayNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr handle);
}
'@
}

$script:Icons = @{
    Ready = New-StatusIcon ([Drawing.Color]::FromArgb(34, 197, 94))
    Pending = New-StatusIcon ([Drawing.Color]::FromArgb(234, 179, 8))
    Offline = New-StatusIcon ([Drawing.Color]::FromArgb(239, 68, 68))
}

$script:NotifyIcon = [Windows.Forms.NotifyIcon]::new()
$script:NotifyIcon.Icon = $script:Icons.Pending.Icon
$script:NotifyIcon.Text = 'OpenClaw Direct Tools: Starting'

$script:ContextMenu = [Windows.Forms.ContextMenuStrip]::new()
$script:StateItem = [Windows.Forms.ToolStripMenuItem]::new('Status: Starting')
$script:StateItem.Enabled = $false
$script:GatewayItem = [Windows.Forms.ToolStripMenuItem]::new('Gateway: Checking')
$script:GatewayItem.Enabled = $false
$script:BridgeItem = [Windows.Forms.ToolStripMenuItem]::new('MCP Bridge: Checking')
$script:BridgeItem.Enabled = $false
$script:TunnelItem = [Windows.Forms.ToolStripMenuItem]::new('Secure MCP Tunnel: Checking')
$script:TunnelItem.Enabled = $false
$script:OpenMonitorItem = [Windows.Forms.ToolStripMenuItem]::new('Open Monitor')
$script:RestartItem = [Windows.Forms.ToolStripMenuItem]::new('Restart Bridge')
$script:StopServiceItem = [Windows.Forms.ToolStripMenuItem]::new('Stop OpenClaw Direct Tools')
$script:ExitItem = [Windows.Forms.ToolStripMenuItem]::new('Exit tray app')

[void]$script:ContextMenu.Items.Add($script:StateItem)
[void]$script:ContextMenu.Items.Add($script:GatewayItem)
[void]$script:ContextMenu.Items.Add($script:BridgeItem)
[void]$script:ContextMenu.Items.Add($script:TunnelItem)
[void]$script:ContextMenu.Items.Add([Windows.Forms.ToolStripSeparator]::new())
[void]$script:ContextMenu.Items.Add($script:OpenMonitorItem)
[void]$script:ContextMenu.Items.Add($script:RestartItem)
[void]$script:ContextMenu.Items.Add($script:StopServiceItem)
[void]$script:ContextMenu.Items.Add([Windows.Forms.ToolStripSeparator]::new())
[void]$script:ContextMenu.Items.Add($script:ExitItem)

$script:NotifyIcon.ContextMenuStrip = $script:ContextMenu
$script:NotifyIcon.Visible = $true

$script:OpenMonitorItem.add_Click({
    if ($script:MonitorUrl) { Start-Process -FilePath $script:MonitorUrl }
})
$script:RestartItem.add_Click({
    if ($null -ne $script:RestartUntil -and (Get-Date) -lt $script:RestartUntil) { return }
    try {
        $script:RestartUntil = (Get-Date).AddMinutes(6)
        Set-TrayState 'RESTARTING' ([pscustomobject]@{ Configured = $true; Gateway = $false; Bridge = $false; Tunnel = $false })
        $powerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $RestartScript + '"'
        Start-Process -FilePath $powerShellExe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
        Write-TrayLog 'Bridge restart requested from the tray menu.'
    } catch {
        $script:RestartUntil = $null
        Write-TrayLog ('Could not start bridge restart: ' + $_.Exception.Message)
        Update-TrayStatus
    }
})
$script:StopServiceItem.add_Click({
    try {
        $script:StopServiceItem.Enabled = $false
        $powerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ServiceStopScript + '"'
        Start-Process -FilePath $powerShellExe -ArgumentList $arguments -WindowStyle Hidden | Out-Null
        Write-TrayLog 'Central service stop requested from the tray menu.'
    } catch {
        $script:StopServiceItem.Enabled = $true
        Write-TrayLog ('Could not start service shutdown: ' + $_.Exception.Message)
    }
})
$script:ExitItem.add_Click({
    Set-Content -LiteralPath $TrayDisabledFile -Value 'disabled' -Encoding ASCII
    Write-TrayLog 'Tray app exit requested by the user.'
    [Windows.Forms.Application]::Exit()
})
$script:NotifyIcon.add_DoubleClick({
    if ($script:MonitorUrl) { Start-Process -FilePath $script:MonitorUrl }
})

$script:Timer = [Windows.Forms.Timer]::new()
$script:Timer.Interval = 3500
$script:Timer.add_Tick({ Update-TrayStatus })
$script:Timer.Start()

Write-TrayLog 'Tray companion started.'
Update-TrayStatus
try {
    [Windows.Forms.Application]::Run()
} finally {
    $script:Timer.Stop()
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
    $script:ContextMenu.Dispose()
    foreach ($entry in $script:Icons.Values) {
        try {
            $entry.Icon.Dispose()
            [void][ChatGPTDirectToolsTrayNative]::DestroyIcon([IntPtr]$entry.Handle)
        } catch {}
    }
    Write-TrayLog 'Tray companion stopped.'
}
