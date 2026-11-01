[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$AppHome = Join-Path $env:LOCALAPPDATA 'OpenClawChatGPTBridge'
$ConfigFile = Join-Path $AppHome 'config.json'
$LogDir = Join-Path $AppHome 'logs'
$LogFile = Join-Path $LogDir 'service-supervisor.log'
$ServicePidFile = Join-Path $AppHome 'service.pid'
$ServiceStopFile = Join-Path $AppHome 'service.stop'
$TrayDisabledFile = Join-Path $AppHome 'tray.disabled'
$GatewayStopFile = Join-Path $AppHome 'gateway-task.stop'
$GatewayScript = Join-Path $PSScriptRoot 'gateway-task.ps1'
$StartScript = Join-Path $PSScriptRoot 'start.ps1'
$StopScript = Join-Path $PSScriptRoot 'stop.ps1'
$TrayLauncherScript = Join-Path $PSScriptRoot 'tray-launcher.vbs'
$PowerShell = Join-Path $PSHOME 'powershell.exe'
$WindowsScriptHost = Join-Path $env:WINDIR 'System32\wscript.exe'
$Mutex = $null
$OwnsMutex = $false
$JobHandle = [IntPtr]::Zero
$GatewayProcess = $null
$TrayProcess = $null
$StartProcess = $null
$ExitCode = 0
$Cfg = $null

function Write-ServiceLog([string]$Message) {
    try {
        if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 2MB) {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.' + $stamp + '.previous') -Force
        }
        $entry = '[' + (Get-Date).ToString('o') + '] ' + $Message + [Environment]::NewLine
        [IO.File]::AppendAllText($LogFile, $entry, [Text.UTF8Encoding]::new($false))
    } catch {}
}

function Get-Json([string]$Url) {
    try { Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop }
    catch { $null }
}

function Test-GatewayListener {
    $client = $null
    try {
        $client = [Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync('127.0.0.1', [int]$Cfg.gatewayPort)
        return [bool]($task.Wait(750) -and $client.Connected)
    } catch {
        return $false
    } finally {
        if ($null -ne $client) { $client.Dispose() }
    }
}

function Test-BridgeHealthy {
    $health = Get-Json ('http://127.0.0.1:' + [int]$Cfg.bridgePort + '/healthz')
    return [bool]($health -and $health.ok -and $health.server -eq 'openclaw-chatgpt-bridge')
}

function Test-TunnelReady {
    $ready = Get-Json ('http://127.0.0.1:' + [int]$Cfg.tunnelHealthPort + '/readyz')
    return [bool]($ready -and (($ready -is [string] -and $ready.Trim() -eq 'ready') -or $ready.status -eq 'ready'))
}

function Start-ChildScript([string]$ScriptPath, [string]$Name, [string]$ExtraArguments = '') {
    $stdout = Join-Path $LogDir ($Name + '.stdout.log')
    $stderr = Join-Path $LogDir ($Name + '.stderr.log')
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    foreach ($path in @($stdout, $stderr)) {
        if (Test-Path -LiteralPath $path) {
            Move-Item -LiteralPath $path -Destination ($path + '.' + $stamp + '.previous') -Force
        }
    }
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '"'
    if (-not [string]::IsNullOrWhiteSpace($ExtraArguments)) { $arguments += ' ' + $ExtraArguments }
    Start-Process -FilePath $PowerShell -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
}

function Ensure-GatewaySupervisor {
    if ($null -ne $GatewayProcess) {
        try {
            $GatewayProcess.Refresh()
            if (-not $GatewayProcess.HasExited) { return }
            Write-ServiceLog ("Gateway supervisor exited (PID " + $GatewayProcess.Id + ", code " + $GatewayProcess.ExitCode + "); restarting its supervisor.")
            $GatewayProcess.Dispose()
        } catch {}
        $script:GatewayProcess = $null
    }

    if (Test-Path -LiteralPath $GatewayStopFile) {
        Remove-Item -LiteralPath $GatewayStopFile -Force -ErrorAction SilentlyContinue
    }
    $script:GatewayProcess = Start-ChildScript -ScriptPath $GatewayScript -Name 'gateway-supervisor'
    Write-ServiceLog ("Started Gateway supervisor (PID " + $script:GatewayProcess.Id + ").")
}

function Invoke-StackStart {
    if ($null -ne $StartProcess) {
        try {
            $StartProcess.Refresh()
            if (-not $StartProcess.HasExited) { return $false }
            $StartProcess.Dispose()
        } catch {}
        $script:StartProcess = $null
    }

    $script:StartProcess = Start-ChildScript -ScriptPath $StartScript -Name 'stack-start' -ExtraArguments '-NoBrowser'
    Write-ServiceLog ("Started stack reconciliation (PID " + $script:StartProcess.Id + ").")
    $deadline = (Get-Date).AddSeconds(450)

    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $ServiceStopFile) {
            try { Stop-Process -Id $script:StartProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
            return $false
        }

        try {
            $script:StartProcess.Refresh()
            if ($script:StartProcess.HasExited) {
                $exit = [int]$script:StartProcess.ExitCode
                $script:StartProcess.Dispose()
                $script:StartProcess = $null
                if ($exit -eq 0) {
                    Write-ServiceLog 'Stack reconciliation completed successfully.'
                    return $true
                }

                $detail = ''
                $stderr = Join-Path $LogDir 'stack-start.stderr.log'
                if (Test-Path -LiteralPath $stderr) {
                    $detail = (Get-Content -LiteralPath $stderr -Tail 35 -ErrorAction SilentlyContinue) -join ' | '
                }
                Write-ServiceLog ("Stack reconciliation failed (exit=" + $exit + '). ' + $detail)
                return $false
            }
        } catch {
            Write-ServiceLog ('Could not inspect stack-start process: ' + $_.Exception.Message)
        }

        try {
            if ($null -ne $GatewayProcess) {
                $GatewayProcess.Refresh()
                if ($GatewayProcess.HasExited) { Ensure-GatewaySupervisor }
            }
        } catch {}

        Start-Sleep -Milliseconds 500
    }

    try { Stop-Process -Id $script:StartProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
    Write-ServiceLog 'Stack reconciliation exceeded its 450-second startup deadline.'
    $script:StartProcess = $null
    return $false
}

function Start-TrayCompanion {
    if (Test-Path -LiteralPath $TrayDisabledFile) { return }
    try {
        $existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -ieq 'wscript.exe' -and $_.CommandLine -and
            $_.CommandLine.IndexOf($TrayLauncherScript, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } | Select-Object -First 1

        if ($existing) { return }

        $script:TrayProcess = Start-Process -FilePath $WindowsScriptHost -ArgumentList ('"' + $TrayLauncherScript + '"') -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
        Write-ServiceLog ("Started tray companion (launcher PID " + $script:TrayProcess.Id + ').')
    } catch {
        Write-ServiceLog ('Tray companion could not start: ' + $_.Exception.Message)
    }
}

function Stop-OwnedGateway {
    if ($null -eq $Cfg) { return }
    try {
        $listener = Get-NetTCPConnection -State Listen -LocalPort ([int]$Cfg.gatewayPort) -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $listener) { return }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$listener.OwningProcess) -ErrorAction SilentlyContinue
        $expected = $process -and
            $process.ExecutablePath -ieq [string]$Cfg.nodePath -and
            $process.CommandLine -and
            $process.CommandLine.IndexOf([string]$Cfg.openclawCliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $process.CommandLine -match 'gateway\s+run' -and
            $process.CommandLine -match ('--port\s+' + [int]$Cfg.gatewayPort + '(\s|$)')
        if ($expected) {
            Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
            Write-ServiceLog ("Stopped verified Gateway process (PID " + $process.ProcessId + ').')
        } else {
            Write-ServiceLog ("Gateway port " + $Cfg.gatewayPort + ' is owned by an unexpected process; it was left untouched.')
        }
    } catch {
        Write-ServiceLog ('Gateway fallback stop failed: ' + $_.Exception.Message)
    }
}

try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw "Local configuration not found: $ConfigFile" }
    $Cfg = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json -ErrorAction Stop
    foreach ($key in @('openclawHome','openclawStateDir','openclawConfigPath','openclawCliPath','nodePath','gatewayPort','bridgePort','tunnelClientPath','tunnelProfilePath','tunnelHealthPort','logDir')) {
        if ($null -eq $Cfg.$key -or [string]::IsNullOrWhiteSpace([string]$Cfg.$key)) { throw "Local config is missing '$key'." }
    }

    $Mutex = [System.Threading.Mutex]::new($false, 'Local\OpenClawDirectToolsService')
    try { $OwnsMutex = $Mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $OwnsMutex = $true }
    if (-not $OwnsMutex) {
        Write-ServiceLog 'Another service supervisor already owns the stack; this instance is exiting.'
        exit 0
    }

    if (-not ('OpenClawDirectToolsJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OpenClawDirectToolsJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateAndAssignCurrentProcess() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        ExtendedLimitInformation info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        return job;
    }

    public static void Close(IntPtr job) {
        if (job != IntPtr.Zero) CloseHandle(job);
    }
}
'@
    }

    try {
        $JobHandle = [OpenClawDirectToolsJob]::CreateAndAssignCurrentProcess()
        Write-ServiceLog 'Process-tree containment is active; ending the service process also ends its managed child processes.'
    } catch {
        Write-ServiceLog ('Job Object containment is unavailable; graceful stop remains available. ' + $_.Exception.Message)
    }

    Set-Content -LiteralPath $ServicePidFile -Value $PID -Encoding ASCII
    Write-ServiceLog ("Service supervisor started (PID " + $PID + ', repo=' + $RepoRoot + ').')

    if (Test-Path -LiteralPath $ServiceStopFile) {
        Remove-Item -LiteralPath $ServiceStopFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $TrayDisabledFile -Force -ErrorAction SilentlyContinue
    Ensure-GatewaySupervisor
    Start-TrayCompanion

    $lastGatewayCheck = [DateTime]::MinValue
    $lastTrayCheck = [DateTime]::MinValue
    $lastStackStart = [DateTime]::MinValue

    $lastLoopError = ''
    $lastLoopErrorAt = [DateTime]::MinValue

    while (-not (Test-Path -LiteralPath $ServiceStopFile)) {
        try {
            Ensure-GatewaySupervisor
            if (((Get-Date) - $lastTrayCheck).TotalSeconds -ge 10) {
                Start-TrayCompanion
                $lastTrayCheck = Get-Date
            }

            if (((Get-Date) - $lastGatewayCheck).TotalSeconds -ge 5) {
                $gatewayListening = Test-GatewayListener
                $lastGatewayCheck = Get-Date
                if ($gatewayListening) {
                    $bridgeHealthy = Test-BridgeHealthy
                    $tunnelReady = Test-TunnelReady
                    if (-not $bridgeHealthy -or -not $tunnelReady) {
                        if ($lastStackStart -eq [DateTime]::MinValue -or ((Get-Date) - $lastStackStart).TotalSeconds -ge 15) {
                            $lastStackStart = Get-Date
                            [void](Invoke-StackStart)
                        }
                    }
                }
            }
        } catch {
            $detail = $_.Exception.ToString()
            $scriptStack = $_.ScriptStackTrace
            if ($detail -ne $lastLoopError -or ((Get-Date) - $lastLoopErrorAt).TotalSeconds -ge 30) {
                Write-ServiceLog ('Supervisor loop iteration failed; recovery will retry. ' + $detail + ' | script=' + $scriptStack)
                $lastLoopError = $detail
                $lastLoopErrorAt = Get-Date
            }
        }

        Start-Sleep -Milliseconds 1000
    }
    Write-ServiceLog 'Stop request received.'
} catch {
    $ExitCode = 1
    Write-ServiceLog ('Service supervisor failed: ' + $_.Exception.ToString() + ' | script=' + $_.ScriptStackTrace)
} finally {
    if ($OwnsMutex) {
        Write-ServiceLog 'Beginning coordinated shutdown.'
        if (-not (Test-Path -LiteralPath $ServiceStopFile)) {
            Set-Content -LiteralPath $ServiceStopFile -Value 'stop' -Encoding ASCII
        }

        Remove-Item -LiteralPath $GatewayStopFile -Force -ErrorAction SilentlyContinue
        try {
            if (Test-Path -LiteralPath $StopScript -PathType Leaf) {
                & $StopScript *>&1 | ForEach-Object {
                    $message = ($_ | Out-String -Width 240).TrimEnd()
                    if ($message) { Write-ServiceLog $message }
                }
            }
        } catch {
            Write-ServiceLog ('Bridge/tunnel shutdown failed: ' + $_.Exception.Message)
        }

        Set-Content -LiteralPath $GatewayStopFile -Value 'stop' -Encoding ASCII
        if ($null -ne $GatewayProcess) {
            $deadline = (Get-Date).AddSeconds(30)
            do {
                Start-Sleep -Milliseconds 250
                try { $GatewayProcess.Refresh() } catch {}
            } while ($GatewayProcess -and -not $GatewayProcess.HasExited -and (Get-Date) -lt $deadline)
        }
        Stop-OwnedGateway

        if ($null -ne $StartProcess) {
            try {
                $StartProcess.Refresh()
                if (-not $StartProcess.HasExited) { Stop-Process -Id $StartProcess.Id -Force -ErrorAction SilentlyContinue }
                $StartProcess.Dispose()
            } catch {}
        }

        if ($null -ne $TrayProcess) {
            try {
                $deadline = (Get-Date).AddSeconds(6)
                do {
                    Start-Sleep -Milliseconds 250
                    $TrayProcess.Refresh()
                } while (-not $TrayProcess.HasExited -and (Get-Date) -lt $deadline)
                if (-not $TrayProcess.HasExited) { Stop-Process -Id $TrayProcess.Id -Force -ErrorAction SilentlyContinue }
                $TrayProcess.Dispose()
            } catch {}
        }

        if ($null -ne $GatewayProcess) {
            try {
                $GatewayProcess.Refresh()
                if (-not $GatewayProcess.HasExited) {
                    Stop-Process -Id $GatewayProcess.Id -Force -ErrorAction SilentlyContinue
                }
                $GatewayProcess.Dispose()
            } catch {}
        }

        Remove-Item -LiteralPath $ServicePidFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ServiceStopFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $GatewayStopFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $TrayDisabledFile -Force -ErrorAction SilentlyContinue
        Write-ServiceLog 'Coordinated shutdown finished.'
        if ($null -ne $Mutex) {
            try { $Mutex.ReleaseMutex() } catch {}
        }
    }

    if ($null -ne $Mutex) { $Mutex.Dispose() }
    if ($JobHandle -ne [IntPtr]::Zero) {
        [OpenClawDirectToolsJob]::Close($JobHandle)
    }
}

exit $ExitCode
