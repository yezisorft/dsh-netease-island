#requires -Version 5.1
<#
  run-e2e.ps1 - end-to-end verification for dsh-netease-island (dev tool).

  Needs an UNCONFINED shell: a sandboxed shell cannot give a Node child piped
  stdio (spawn EPERM), cannot start Chromium (mojo named pipe denied), and
  cannot launch NetEase Cloud Music.

  Steps
    A. enumerate existing Windows SMTC sessions
    B. start Edge as a real SMTC source (silent WAV + MediaSession metadata)
    C. run dev/test-bridge.mjs against that live session
    D. screenshot the island UI through headless Edge
    E. launch NetEase Cloud Music and report the app id it registers

  THIS FILE MUST STAY PURE ASCII.
#>
param(
  [switch]$SkipNetease
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\ye\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$netease = 'C:\Program Files\NetEase\CloudMusic\cloudmusic.exe'
$shots = Join-Path $PSScriptRoot 'shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$script:edgePids = @()

function Probe {
  $lines = & $ps51 -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'probe-sessions.ps1') 2>&1
  $json = ($lines | Where-Object { $_ -match '^\s*\{"count"' } | Select-Object -Last 1)
  if (-not $json) { return $null }
  try { return ($json | ConvertFrom-Json) } catch { return $null }
}

function Show-Sessions($label, $probe) {
  if ($null -eq $probe) { Write-Output ("[$label] probe failed"); return }
  Write-Output ("[$label] count=" + $probe.count)
  foreach ($s in @($probe.sessions)) {
    Write-Output ("   appId=" + $s.appId + " status=" + $s.status + " title=" + $s.title + " dur=" + $s.durationSec)
  }
}

function Stop-Edge {
  $killed = 0
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop
    foreach ($p in $procs) {
      if ($p.CommandLine -and $p.CommandLine -match 'edge-profile|edge-headless') {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
      }
    }
  } catch {
    foreach ($id in $script:edgePids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $killed++ }
  }
  Write-Output ("   stopped $killed edge process(es)")
}

Write-Output '================ A. SMTC sessions before ================'
Show-Sessions 'before' (Probe)

Write-Output ''
Write-Output '================ B. start Edge as a real SMTC source ================'
$edgeArgs = @(
  "--user-data-dir=$PSScriptRoot\edge-profile",
  '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--new-window', 'http://127.0.0.1:8917/smtc-test.html'
)
$edgeProc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -ErrorAction SilentlyContinue
if ($edgeProc) { $script:edgePids += $edgeProc.Id; Write-Output ('   edge pid=' + $edgeProc.Id) }
else { Write-Output '   EDGE FAILED TO START' }

$live = $null
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 2
  $p = Probe
  if ($p -and $p.count -gt 0) {
    $playing = @($p.sessions | Where-Object { $_.status -eq 'Playing' })
    if ($playing.Count -gt 0) { $live = $p; break }
  }
}
if ($live) { Show-Sessions 'after-start' $live } else { Write-Output '   no playing SMTC session appeared' }

Write-Output ''
Write-Output '================ C. bridge integration test ================'
& $node (Join-Path $PSScriptRoot 'test-bridge.mjs') 2>&1 | Out-String -Width 300
Write-Output ('   bridge-test exit=' + $LASTEXITCODE)

Write-Output ''
Write-Output '================ C2. session snapshot after control ================'
Show-Sessions 'after-control' (Probe)

Write-Output ''
Write-Output '================ D. island UI screenshots (headless) ================'
Stop-Edge
$headlessArgs = @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--virtual-time-budget=5000',
  "--user-data-dir=$PSScriptRoot\edge-headless"
)
$shotsToTake = @(
  @{ name = 'island-collapsed.png';  size = '900,300';  url = 'http://127.0.0.1:8917/harness.html' },
  @{ name = 'island-expanded.png';   size = '900,300';  url = 'http://127.0.0.1:8917/harness.html?expanded=1' },
  @{ name = 'island-paused.png';     size = '900,300';  url = 'http://127.0.0.1:8917/harness.html?paused=1&expanded=1' },
  @{ name = 'island-desktop.png';    size = '1280,800'; url = 'http://127.0.0.1:8917/harness.html?expanded=1' }
)
foreach ($s in $shotsToTake) {
  $out = Join-Path $shots $s.name
  if (Test-Path $out) { Remove-Item $out -Force }
  $a = $headlessArgs + @("--window-size=$($s.size)", "--screenshot=$out", $s.url)
  $hp = Start-Process -FilePath $edge -ArgumentList $a -PassThru -Wait -ErrorAction SilentlyContinue
  if ($hp) { $script:edgePids += $hp.Id }
  if (Test-Path $out) {
    Write-Output ('   ' + $s.name + ' -> ' + (Get-Item $out).Length + ' bytes')
  } else {
    Write-Output ('   ' + $s.name + ' -> FAILED (exit ' + ($hp.ExitCode) + ')')
  }
}

if (-not $SkipNetease) {
  Write-Output ''
  Write-Output '================ E. NetEase Cloud Music app id probe ================'
  $np = Start-Process -FilePath $netease -PassThru -ErrorAction SilentlyContinue
  if ($np) {
    Write-Output ('   started cloudmusic pid=' + $np.Id)
    for ($i = 0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 2
      $p = Probe
      $hit = $null
      if ($p) { $hit = @($p.sessions | Where-Object { $_.appId -match 'cloudmusic|netease|Music' }) }
      if ($hit -and $hit.Count -gt 0) { break }
    }
    Show-Sessions 'netease' (Probe)
    Write-Output '   (leaving NetEase running as the user may expect it; close it manually if not wanted)'
  } else {
    Write-Output '   CLOUDMUSIC FAILED TO START'
  }
}

Write-Output ''
Write-Output '================ done ================'
