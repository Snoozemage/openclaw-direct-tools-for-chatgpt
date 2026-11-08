# Native regression: WinForms may grow a ten-pixel border to sixteen pixels.
# Assert the real Form bounds still anchor every outer edge to its monitor.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot '..\scripts\windows\ScreenBorder.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
$assembly = [OpenClawScreenBorder.Host].Assembly
$flags = [Reflection.BindingFlags]'NonPublic,Static'
$native = $assembly.GetType('OpenClawScreenBorder.Native')
[void]$native.GetMethod('SetProcessDpiAwarenessContext', $flags).Invoke($null, @([IntPtr]::new(-4)))
$edgeType = $assembly.GetType('OpenClawScreenBorder.Edge')
$constructor = $edgeType.GetConstructors()[0]
$display = $edgeType.GetMethod('Display')
foreach ($screen in [Windows.Forms.Screen]::AllScreens) {
    $b = $screen.Bounds
    $rectangles = @(
        [Drawing.Rectangle]::new($b.Left, $b.Top, $b.Width, 10),
        [Drawing.Rectangle]::new($b.Left, $b.Bottom - 10, $b.Width, 10),
        [Drawing.Rectangle]::new($b.Left, $b.Top + 10, 10, $b.Height - 20),
        [Drawing.Rectangle]::new($b.Right - 10, $b.Top + 10, 10, $b.Height - 20)
    )
    for ($side = 0; $side -lt 4; $side++) {
        $window = $constructor.Invoke(@($rectangles[$side], $side, $true))
        try {
            [void]$display.Invoke($window, @())
            $actual = $window.Bounds
            if ($actual.Left -lt $b.Left -or $actual.Top -lt $b.Top -or $actual.Right -gt $b.Right -or $actual.Bottom -gt $b.Bottom) {
                throw "Border $side extends beyond monitor: $actual versus $b"
            }
            $aligned = switch ($side) {
                0 { $actual.Top -eq $b.Top }
                1 { $actual.Bottom -eq $b.Bottom }
                2 { $actual.Left -eq $b.Left }
                3 { $actual.Right -eq $b.Right }
            }
            if (-not $aligned) { throw "Border $side does not align: $actual versus $b" }
            Write-Output ("Edge {0}: {1}, aligned" -f $side, $actual)
        } finally { $window.Dispose() }
    }
}
