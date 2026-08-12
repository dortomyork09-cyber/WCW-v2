param([string]$action, [long]$value = 0)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null

try {
    $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $manager.GetCurrentSession()
    if ($session -eq $null) { exit }

    switch ($action) {
        "play-pause" { $session.TryTogglePlayPauseAsync() | Out-Null }
        "next"       { $session.TrySkipNextAsync() | Out-Null }
        "prev"       { $session.TrySkipPreviousAsync() | Out-Null }
        "seek"       { $session.TryChangePlaybackPositionAsync($value * 10000000) | Out-Null }
    }
    Start-Sleep -Milliseconds 200
} catch {}