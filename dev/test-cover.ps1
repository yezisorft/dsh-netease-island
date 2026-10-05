# Cover-art extraction unit test.
#
# The end-to-end bridge test cannot cover the artwork path: the only SMTC source
# available in this sandbox (Edge) publishes no thumbnail, so that check is
# skipped. This closes the gap from the other side by running the REAL
# Get-CoverBase64 out of lib/smtc-bridge.ps1 against REAL WinRT objects, so the
# stream -> Size -> DataReader -> bytes -> mime -> base64 path is exercised
# exactly as $props.Thumbnail drives it.
#
# Why an InMemoryRandomAccessStream instead of a file: StorageFile.GetFileFromPathAsync
# fails from this process with 0x80070005 UnauthorizedAccessException ("the item is
# not in a location the app can access"). That is the documented behaviour for an
# unpackaged desktop process, which has no package identity to grant a capability
# scope - not a sandbox quirk. So the reference is built with
# RandomAccessStreamReference.CreateFromStream, which yields the same
# IRandomAccessStreamReference that a player hands us, including the
# content-type-less stream that the mime sniffing below exists to handle.
#
# Must run under Windows PowerShell 5.1 (pwsh is .NET Core and cannot load
# System.Runtime.WindowsRuntime). Pure ASCII on purpose: a BOM-less .ps1 with
# non-ASCII literals is decoded with the machine ANSI code page and corrupts.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File dev\test-cover.ps1

$ErrorActionPreference = 'Stop'

$script:pass = 0
$script:fail = 0
$script:skip = 0
function Ok($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host ("  PASS  " + $name) }
  else { $script:fail++; Write-Host ("  FAIL  " + $name + "  <- " + $detail) }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$plugin = Split-Path -Parent $here
$art = Join-Path $here 'art.png'

Write-Host "== cover-art extraction =="
Write-Host ("payload = " + $art + " (" + (Get-Item $art).Length + "B)")

# Dot-source the real bridge for its helpers only: no ready line, no stdin
# reader runspace, no poll loop.
. (Join-Path $plugin 'lib\smtc-bridge.ps1') -LibraryOnly

Ok 'Get-CoverBase64 is defined by the bridge' ([bool](Get-Command Get-CoverBase64 -ErrorAction SilentlyContinue)) 'function missing'

# Most sessions publish no artwork, so this path must not throw.
$nullResult = Get-CoverBase64 $null
Ok 'null thumbnail returns null' ($null -eq $nullResult) ("got " + $nullResult)

[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

# Build a real IRandomAccessStreamReference over a real byte payload. The cursor
# is deliberately left at the end of the stream: OpenReadAsync is specified to
# return position 0, but the bridge must not depend on that, so this doubles as
# a check that it seeks before reading.
function New-ThumbnailRef($bytes) {
  $mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($mem)
  $writer.WriteBytes($bytes)
  Await ($writer.StoreAsync()) ([uint32]) | Out-Null
  $writer.DetachStream() | Out-Null
  return [Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromStream($mem)
}

$fileBytes = [System.IO.File]::ReadAllBytes($art)
$ref = New-ThumbnailRef $fileBytes
Ok 'stream reference created' ($null -ne $ref) 'CreateFromStream returned null'

$cover = Get-CoverBase64 $ref
Ok 'extraction returns a result' ($null -ne $cover) 'Get-CoverBase64 returned null for a real stream'

if ($null -ne $cover) {
  Ok 'result carries data' ([bool]$cover.data) 'data is empty'

  $bytes = $null
  try { $bytes = [Convert]::FromBase64String($cover.data) } catch { }
  Ok 'base64 decodes' ($null -ne $bytes) 'FromBase64String threw'

  if ($null -ne $bytes) {
    Ok 'decoded length matches the payload' ($bytes.Length -eq $fileBytes.Length) ($bytes.Length.ToString() + " vs " + $fileBytes.Length.ToString())

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $h1 = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    $h2 = [BitConverter]::ToString($sha.ComputeHash($fileBytes)).Replace('-', '')
    Ok 'decoded bytes are byte-identical to the payload' ($h1 -eq $h2) ($h1 + " vs " + $h2)

    $pngMagic = ($bytes.Length -ge 8 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)
    Ok 'decoded bytes really are a PNG' $pngMagic 'PNG signature missing'
  }

  # An in-memory reference carries no content type, which is precisely the case
  # the magic-byte sniffing was added for.
  Ok 'mime is inferred when the stream reports none' ($cover.mime -eq 'image/png') ("mime = '" + $cover.mime + "'")
}

# The 8 MiB cap guards the pipe and the browser against a pathological thumbnail.
$oversize = New-Object byte[] 8388609
$bigRef = New-ThumbnailRef $oversize
$big = Get-CoverBase64 $bigRef
Ok 'oversized thumbnail is refused' ($null -eq $big) 'a >8MiB thumbnail was accepted'

Write-Host ""
Write-Host ("SUMMARY pass=" + $script:pass + " fail=" + $script:fail + " skip=" + $script:skip)
if ($script:fail -gt 0) { exit 1 }
exit 0
