[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

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

    if ($session -eq $null) {
        Write-Output '{"status":"none"}'
        exit
    }

    $info = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()

    $title = $info.Title -replace '"', '' -replace '\\', ''
    $artist = $info.Artist -replace '"', '' -replace '\\', ''
    $status = $playback.PlaybackStatus.ToString()
    $pos = [long]($timeline.Position.TotalSeconds)
    $dur = [long]($timeline.EndTime.TotalSeconds)

    # 썸네일을 파일로 저장
    $thumbPath = "C:\WCW\thumb.jpg"
    $hasThumbnail = "false"
    try {
        $thumb = $info.Thumbnail
        if ($thumb -ne $null) {
            $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            $size = [uint32]$stream.Size
            if ($size -gt 0) {
                $buffer = New-Object byte[] $size
                $dataReader = [Windows.Storage.Streams.DataReader]::new($stream)
                $loadOp = $dataReader.LoadAsync($size)
                Await $loadOp ([uint32]) | Out-Null
                $dataReader.ReadBytes($buffer)
                [System.IO.File]::WriteAllBytes($thumbPath, $buffer)
                $hasThumbnail = "true"
            }
        }
    } catch {}

    Write-Output "{""title"":""$title"",""artist"":""$artist"",""status"":""$status"",""position"":$pos,""duration"":$dur,""hasThumbnail"":$hasThumbnail}"
} catch {
    Write-Output '{"status":"none"}'
}