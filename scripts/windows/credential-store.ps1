# Load the precompiled interop helpers from the bundled Windows launcher assembly.
$credentialStoreType = 'OpenClawBridge.WindowsCredentialStore' -as [type]
if ($null -eq $credentialStoreType) {
    $launcherExecutable = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\assets\OpenClaw Direct Tools.exe'))
    if (-not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) {
        throw "Bundled native helper assembly not found: $launcherExecutable"
    }

    [void][Reflection.Assembly]::LoadFrom($launcherExecutable)
    $credentialStoreType = 'OpenClawBridge.WindowsCredentialStore' -as [type]
    if ($null -eq $credentialStoreType) {
        throw 'The bundled launcher does not contain the Windows Credential Manager helper.'
    }
}
