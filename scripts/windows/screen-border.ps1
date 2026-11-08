[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [switch]$IncludeInCapture
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'ScreenBorder.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
[OpenClawScreenBorder.Host]::Run($ParentProcessId, -not $IncludeInCapture)
