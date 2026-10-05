#requires -Version 5.1
<#
  recheck.ps1 - focused re-verification of dsh-netease-island after a fix.

  Runs only the parts that need an unconfined shell:
    B. Edge as a real SMTC source
    C. bridge integration test (dev/test-bridge.mjs)
    D. island UI screenshots + DOM dump (headless Edge)

  Skips the NetEase app-id probe (run-e2e.ps1 section E does that).
  THIS FILE MUST STAY PURE ASCII.
#>
param(
  [switch]$SkipBridge,
  [switch]$SkipShots
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\ye\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$ps51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$shots = Join-Path $PSScriptRoot 'shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

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
    Write-Output ("   appId=" + $s.appId + " status=" + $s.status + " dur=" + $s.durationSec)
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
  } catch { }
  Write-Output ("   stopped $killed edge process(es)")
}

# Reset the harness mock into a playing state so the shots show a live island.
try {
  $body = '{"cmd":"play"}'
  Invoke-WebRequest -Uri 'http://127.0.0.1:8917/dsh-netease/command' -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-Output '[mock] harness mock set to playing'
} catch {
  Write-Output ('[mock] WARNING: could not reach the dev server on 8917: ' + $_.Exception.Message)
}

if (-not $SkipBridge) {
  Write-Output ''
  Write-Output '================ B. start Edge as a real SMTC source ================'
  $edgeArgs = @(
    "--user-data-dir=$PSScriptRoot\edge-profile",
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--new-window', 'http://127.0.0.1:8917/smtc-test.html'
  )
  $edgeProc = Start-Process -FilePath $edge -ArgumentList $edgeArgs -PassThru -ErrorAction SilentlyContinue
  if ($edgeProc) { Write-Output ('   edge pid=' + $edgeProc.Id) } else { Write-Output '   EDGE FAILED TO START' }

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
}

if (-not $SkipShots) {
  Write-Output ''
  Write-Output '================ D. island UI screenshots (headless) ================'
  Stop-Edge
  $headlessArgs = @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--virtual-time-budget=5000',
    "--user-data-dir=$PSScriptRoot\edge-headless"
  )
  $shotsToTake = @(
    @{ name = 'island-collapsed.png'; size = '900,300';  url = 'http://127.0.0.1:8917/harness.html?static=1' },
    @{ name = 'island-expanded.png';  size = '900,300';  url = 'http://127.0.0.1:8917/harness.html?static=1&expanded=1' },
    @{ name = 'island-paused.png';    size = '900,300';  url = 'http://127.0.0.1:8917/harness.html?static=1&expanded=1&paused=1' },
    @{ name = 'island-desktop.png';   size = '1280,800'; url = 'http://127.0.0.1:8917/harness.html?static=1&expanded=1' }
  )
  foreach ($s in $shotsToTake) {
    $out = Join-Path $shots $s.name
    if (Test-Path $out) { Remove-Item $out -Force }
    $a = $headlessArgs + @("--window-size=$($s.size)", "--screenshot=$out", $s.url)
    $hp = Start-Process -FilePath $edge -ArgumentList $a -PassThru -Wait -ErrorAction SilentlyContinue
    if (Test-Path $out) {
      Write-Output ('   ' + $s.name + ' -> ' + (Get-Item $out).Length + ' bytes')
    } else {
      Write-Output ('   ' + $s.name + ' -> FAILED (exit ' + ($hp.ExitCode) + ')')
    }
  }

  Write-Output ''
  Write-Output '   ---- DOM proof: does the island host exist and is it visible? ----'
  $domFile = Join-Path $shots 'dom-expanded.html'
  if (Test-Path $domFile) { Remove-Item $domFile -Force }
  $da = $headlessArgs + @('--window-size=900,300', '--dump-dom', 'http://127.0.0.1:8917/harness.html?expanded=1')
  $dp = Start-Process -FilePath $edge -ArgumentList $da -PassThru -Wait -RedirectStandardOutput $domFile -ErrorAction SilentlyContinue
  if (Test-Path $domFile) {
    $dom = Get-Content $domFile -Raw
    $m = [regex]::Match($dom, '<div[^>]*id="dsh-netease-island-root"[^>]*>')
    if ($m.Success) { Write-Output ('   HOST ELEMENT: ' + $m.Value) } else { Write-Output '   HOST ELEMENT: NOT FOUND' }
  } else {
    Write-Output '   DOM dump FAILED'
  }

  Write-Output ''
  Write-Output '   ---- on-screen geometry: is the SETTLED island inside the viewport and opaque? ----'
  $geomFailures = 0
  foreach ($st in @(
    @{ label = 'collapsed'; q = '?debug=1&static=1'; minW = 150 },
    @{ label = 'expanded';  q = '?debug=1&static=1&expanded=1'; minW = 300 }
  )) {
    $gFile = Join-Path $shots ('geom-' + $st.label + '.html')
    if (Test-Path $gFile) { Remove-Item $gFile -Force }
    $ga = $headlessArgs + @('--window-size=900,300', '--dump-dom', ('http://127.0.0.1:8917/harness.html' + $st.q))
    Start-Process -FilePath $edge -ArgumentList $ga -PassThru -Wait -RedirectStandardOutput $gFile -ErrorAction SilentlyContinue | Out-Null
    $gdom = if (Test-Path $gFile) { Get-Content $gFile -Raw -Encoding UTF8 } else { '' }
    $gm = [regex]::Match($gdom, 'GEOMETRY_JSON=(\{.*?\})</pre>')
    if (-not $gm.Success) { Write-Output ('   FAIL  [' + $st.label + '] geometry report missing'); $geomFailures++; continue }
    try { $g = $gm.Groups[1].Value | ConvertFrom-Json } catch { Write-Output ('   FAIL  [' + $st.label + '] geometry report unparsable'); $geomFailures++; continue }
    $vw = [int]$g.viewport.w; $vh = [int]$g.viewport.h
    $ix = [int]$g.island.rect.x; $iy = [int]$g.island.rect.y
    $iw = [int]$g.island.rect.w; $ih = [int]$g.island.rect.h
    $op = [string]$g.host.style.opacity
    $checks = @(
      @{ n = 'island has a real size';            ok = ($iw -ge $st.minW -and $ih -ge 30) },
      @{ n = 'island starts inside the viewport'; ok = ($ix -ge 0 -and $iy -ge 0) },
      @{ n = 'island ends inside the viewport';   ok = (($ix + $iw) -le $vw -and ($iy + $ih) -le $vh) },
      @{ n = 'island wrapper is fully opaque';    ok = ([double]$op -ge 0.99) },
      @{ n = 'island is horizontally centred';    ok = ((($ix + $iw / 2) - ($vw / 2)) -le 4 -and (($vw / 2) - ($ix + $iw / 2)) -le 4) }
    )
    foreach ($c in $checks) {
      if ($c.ok) { Write-Output ('   PASS  [' + $st.label + '] ' + $c.n) }
      else { Write-Output ('   FAIL  [' + $st.label + '] ' + $c.n); $geomFailures++ }
    }
    Write-Output ('   info  [' + $st.label + '] viewport=' + $vw + 'x' + $vh + ' island=' + $iw + 'x' + $ih +
      ' at ' + $ix + ',' + $iy + ' centreDelta=' + (($ix + $iw / 2) - ($vw / 2)) +
      ' wrapperOpacity=' + $op + ' class=' + $g.host.classes)
  }
  Write-Output ('   geometry failures: ' + $geomFailures)
}

Write-Output ''
Write-Output '================ done ================'
