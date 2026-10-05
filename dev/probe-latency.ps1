#requires -Version 5.1
<#
  probe-latency.ps1 - time each Windows SMTC call so the bridge's poll loop can be
  built around the slow ones. Emits a single JSON line.

  THEORY UNDER TEST: TryGetMediaPropertiesAsync is pathologically slow when blocked
  with Task.Wait() on PowerShell's STA thread, while GetPlaybackInfo and
  GetTimelineProperties are fast. If so, the bridge must never block on media
  properties inside its poll loop.

  THIS FILE MUST STAY PURE ASCII.
#>
param([int]$Repeat = 3)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Start-Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  return $m.Invoke($null, @($op))
}
function Await($op, $type) {
  $t = Start-Await $op $type
  $t.Wait(-1) | Out-Null
  return $t.Result
}

function TimeIt {
  param([string]$Label, [scriptblock]$Body)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $result = $null
  $err = $null
  try { $result = & $Body } catch { $err = $_.Exception.Message }
  $sw.Stop()
  return [pscustomobject]@{ label = $Label; ms = [int]$sw.ElapsedMilliseconds; ok = (-not [bool]$err); error = $err; value = $result }
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$timings = @()
$manager = $null
$timings += TimeIt 'request-manager' { $script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) ; 'ok' }
$manager = $script:manager
if ($null -eq $manager) {
  Write-Output (@{ error = 'no manager'; timings = $timings } | ConvertTo-Json -Compress -Depth 6)
  exit 1
}

$sessions = @()
$timings += TimeIt 'get-sessions' { $script:sessions = @($manager.GetSessions()); $script:sessions.Count }
$sessions = $script:sessions
if ($sessions.Count -eq 0) {
  Write-Output (@{ sessions = 0; timings = $timings } | ConvertTo-Json -Compress -Depth 6)
  exit 0
}

$session = $sessions[0]
$timings += TimeIt 'get-playback-info' { [string]$session.GetPlaybackInfo().PlaybackStatus }
$timings += TimeIt 'get-timeline-properties' { $tl = $session.GetTimelineProperties(); [double]$tl.EndTime.TotalSeconds }

for ($i = 0; $i -lt $Repeat; $i++) {
  $timings += TimeIt ("try-get-media-properties-#" + ($i + 1)) {
    $p = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    [string]$p.Title
  }
}

# Does the same call stay slow when awaited on a background runspace instead of
# blocking the pipeline thread? This decides the bridge's design.
$timings += TimeIt 'media-properties-in-runspace' {
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($session)
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $g = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $m = $g.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $t = $m.Invoke($null, @($session.TryGetMediaPropertiesAsync()))
    $t.Wait(-1) | Out-Null
    [string]$t.Result.Title
  }).AddArgument($session)
  $r = $ps.Invoke()
  $ps.Dispose()
  if ($r -and $r.Count -gt 0) { [string]$r[0] } else { '' }
}

Write-Output (@{
  appId    = [string]$session.SourceAppUserModelId
  sessions = $sessions.Count
  timings  = $timings
} | ConvertTo-Json -Compress -Depth 6)
