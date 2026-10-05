#requires -Version 5.1
<#
  probe-sessions.ps1 - list every Windows SMTC media session (dev tool).

  Used to learn which application user model id each media app registers, which
  is what the island's -AppPattern list matches on. Prints ONE line of JSON: an
  array of { appId, status, title, artist, durationSec }.

  Output is forced to pure ASCII (\uXXXX escapes) so it survives any console code
  page on the way back to the caller.

  THIS FILE MUST STAY PURE ASCII - Windows PowerShell 5.1 decodes a BOM-less .ps1
  with the machine ANSI code page.
#>
param(
  [switch]$Raw
)

$ErrorActionPreference = 'Stop'

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

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

function Ascii([string]$value) {
  if ($null -eq $value) { return '' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $value.ToCharArray()) {
    $code = [int]$ch
    if ($code -eq 34) {
      [void]$sb.Append('\"')
    } elseif ($code -eq 92) {
      [void]$sb.Append('\\')
    } elseif ($code -ge 32 -and $code -le 126) {
      [void]$sb.Append($ch)
    } else {
      [void]$sb.Append('\u' + $code.ToString('x4'))
    }
  }
  $sb.ToString()
}

try {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch {
  Write-Output ('{"error":"' + (Ascii $_.Exception.Message) + '"}')
  exit 1
}

$sessions = @($manager.GetSessions())
$items = @()
foreach ($s in $sessions) {
  $status = ''
  $duration = 0
  try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch { }
  # GetTimelineProperties() is a method of the SESSION; calling it on the object
  # returned by GetPlaybackInfo() throws and silently yields a duration of 0.
  try { $duration = [double]$s.GetTimelineProperties().EndTime.TotalSeconds } catch { }
  $title = ''; $artist = ''
  try {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($null -ne $props) { $title = [string]$props.Title; $artist = [string]$props.Artist }
  } catch { }
  $items += ('{"appId":"' + (Ascii ([string]$s.SourceAppUserModelId)) +
    '","status":"' + (Ascii $status) +
    '","title":"' + (Ascii $title) +
    '","artist":"' + (Ascii $artist) +
    '","durationSec":' + ([Math]::Round($duration, 3)).ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}')
}

Write-Output ('{"count":' + $items.Count + ',"sessions":[' + ($items -join ',') + ']}')
