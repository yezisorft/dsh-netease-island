#requires -Version 5.1
<#
  fake-player.ps1 - a scriptable Windows SMTC "now playing" source. DEV ONLY.

  Windows gives no API to publish a bare SMTC session from a desktop process:
  SystemMediaTransportControls.GetForCurrentView() is UWP-only. The supported
  desktop route is Windows.Media.Playback.MediaPlayer, which registers a real
  system media session of its own accord. This script drives one, so the widget's
  bridge can be validated against a genuine SMTC session - metadata, artwork,
  timeline and the transport-command round trip - without NetEase Cloud Music
  having to be installed or running.

  Modes
  -----
    -Probe        start playback, list the sessions SMTC now reports, exit.
    (default)     start playback and hold the process open until stdin closes,
                  so the bridge can poll and control it from another process.
    -HoldSec N    same, but exit after N seconds.

  The audio is a near-silent WAV (1 LSB dither) so the test is inaudible.

  THIS FILE STAYS PURE ASCII: Windows PowerShell 5.1 decodes a BOM-less .ps1
  using the machine ANSI code page, so CJK literals here would be corrupted.
  The Chinese metadata is therefore built from code points.
#>
param(
  [string]$Audio = (Join-Path $PSScriptRoot 'tone.wav'),
  [string]$Art = (Join-Path $PSScriptRoot 'art.png'),
  [int]$PositionSec = 42,
  [int]$HoldSec = 0,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($operation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function Chars([int[]]$codes) { -join ($codes | ForEach-Object { [char]$_ }) }

# A CJK title/artist exercises the bridge's UTF-8 piped output.
$TITLE = Chars @(0x8D77, 0x98CE, 0x4E86, 0xFF08, 0x43, 0x6F, 0x76, 0x65, 0x72, 0x20, 0x9AD8, 0x6A4B, 0x512A, 0xFF09)
$ARTIST = Chars @(0x4E70, 0x8FA3, 0x6912, 0x4E5F, 0x7528, 0x5238)
$ALBUM = Chars @(0x8D77, 0x98CE, 0x4E86)

[Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Playback.MediaPlaybackItem, Windows.Media.Playback, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaPlaybackType, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

if (-not (Test-Path -LiteralPath $Audio)) { throw "audio file not found: $Audio" }

$uri = [Uri]([System.IO.Path]::GetFullPath($Audio))
$source = [Windows.Media.Core.MediaSource]::CreateFromUri($uri)
$item = [Windows.Media.Playback.MediaPlaybackItem]::new($source)

$display = $item.GetDisplayProperties()
$display.Type = [Windows.Media.MediaPlaybackType]::Music
$display.MusicProperties.Title = $TITLE
$display.MusicProperties.Artist = $ARTIST
$display.MusicProperties.AlbumTitle = $ALBUM
if (Test-Path -LiteralPath $Art) {
  $display.Thumbnail = [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromUri([Uri]([System.IO.Path]::GetFullPath($Art)))
}
$item.ApplyDisplayProperties($display)

$player = New-Object Windows.Media.Playback.MediaPlayer
$player.CommandManager.IsEnabled = $true
$player.AudioCategory = [Windows.Media.Playback.MediaPlayerAudioCategory]::Media
$player.Source = $item
$player.Play()

# Give the session a non-zero timeline so the bridge reports a real position.
try { $player.PlaybackSession.Position = [TimeSpan]::FromSeconds($PositionSec) } catch { }

function Get-SessionSummary {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $out = @()
  foreach ($s in @($manager.GetSessions())) {
    $p = $null
    try { $p = $s.GetPlaybackInfo() } catch { }
    $props = $null
    try { $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { }
    $tl = $null
    try { $tl = $p.GetTimelineProperties() } catch { }
    $out += [pscustomobject]@{
      app      = [string]$s.SourceAppUserModelId
      status   = if ($p) { [string]$p.PlaybackStatus } else { '?' }
      title    = if ($props) { [string]$props.Title } else { '' }
      artist   = if ($props) { [string]$props.Artist } else { '' }
      album    = if ($props) { [string]$props.AlbumTitle } else { '' }
      hasArt   = [bool]($props -and $props.Thumbnail)
      posSec   = if ($tl) { [math]::Round([double]$tl.Position.TotalSeconds, 2) } else { 0 }
      durSec   = if ($tl) { [math]::Round([double]$tl.EndTime.TotalSeconds, 2) } else { 0 }
      canNext  = if ($p) { [bool]$p.Controls.IsNextEnabled } else { $false }
      canPrev  = if ($p) { [bool]$p.Controls.IsPreviousEnabled } else { $false }
    }
  }
  return $out
}

if ($Probe) {
  $deadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 400
    $sessions = @(Get-SessionSummary)
  } while ($sessions.Count -eq 0 -and (Get-Date) -lt $deadline)

  [Console]::Out.WriteLine('sessions=' + $sessions.Count)
  foreach ($s in $sessions) {
    [Console]::Out.WriteLine(($s | ConvertTo-Json -Compress -Depth 4))
  }
  try { $player.Pause() } catch { }
  try { $player.Dispose() } catch { }
  exit 0
}

[Console]::Out.WriteLine('fake-player ready: ' + $TITLE + ' / ' + $ARTIST)
[Console]::Out.Flush()

$started = Get-Date
$pending = $null
try { $pending = [Console]::In.ReadLineAsync() } catch { $pending = $null }

while ($true) {
  if ($pending -ne $null -and $pending.IsCompleted) {
    $line = $null
    try { $line = $pending.Result } catch { $line = $null }
    if ($null -eq $line) { break }
    if ($line.Trim() -eq 'quit') { break }
    try { $pending = [Console]::In.ReadLineAsync() } catch { $pending = $null }
  }
  if ($HoldSec -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $HoldSec) { break }
  Start-Sleep -Milliseconds 300
}

try { $player.Pause() } catch { }
try { $player.Dispose() } catch { }
