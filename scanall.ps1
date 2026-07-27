$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::DefaultConnectionLimit = 24
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 1. every card in every catalogue -------------------------------------
$cards = @()
foreach ($e in @('allSetCards','allDonCards','allSTCards','allPromos')) {
  $cards += Invoke-RestMethod -Uri "https://optcgapi.com/api/$e/" -TimeoutSec 180
}
$withArt = $cards | Where-Object { $_.card_image }
Write-Host "cards: $($cards.Count)   with image: $($withArt.Count)"

$urls = $withArt | ForEach-Object { $_.card_image } | Sort-Object -Unique
Write-Host "distinct image urls: $($urls.Count)"

# ---- 2. HEAD every distinct url, concurrently -----------------------------
# Content-Length is enough to prove two files are DIFFERENT. Only urls that
# share a length can possibly be the same file, and only those get downloaded.
$pool = [RunspaceFactory]::CreateRunspacePool(1, 16)
$pool.Open()
$jobs = @()
foreach ($u in $urls) {
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript({
    param($url)
    try {
      $req = [Net.HttpWebRequest]::Create($url)
      $req.Method = 'HEAD'; $req.Timeout = 60000
      $req.UserAgent = 'optcg-quant-image-audit'
      $res = $req.GetResponse()
      $len = $res.ContentLength
      $res.Close()
      return @{ url = $url; len = $len }
    } catch { return @{ url = $url; len = -1 } }
  }).AddArgument($u)
  $jobs += [pscustomobject]@{ ps = $ps; handle = $ps.BeginInvoke() }
}
$heads = @{}
$done = 0
foreach ($j in $jobs) {
  $r = $j.ps.EndInvoke($j.handle)
  $j.ps.Dispose()
  if ($r) { $heads[$r[0].url] = $r[0].len }
  $done++
  if ($done % 500 -eq 0) { Write-Host "  head $done/$($urls.Count)" }
}
$pool.Close(); $pool.Dispose()

$bad = ($heads.GetEnumerator() | Where-Object { $_.Value -le 0 }).Count
Write-Host "heads done. failed/unknown: $bad"

# ---- 3. hash only the urls whose size collides ----------------------------
$byLen = @{}
foreach ($kv in $heads.GetEnumerator()) {
  if ($kv.Value -le 0) { continue }
  $l = [string]$kv.Value
  if (-not $byLen.ContainsKey($l)) { $byLen[$l] = New-Object System.Collections.ArrayList }
  [void]$byLen[$l].Add($kv.Key)
}
$suspectUrls = New-Object System.Collections.ArrayList
foreach ($kv in $byLen.GetEnumerator()) {
  if ($kv.Value.Count -gt 1) { foreach ($u in $kv.Value) { [void]$suspectUrls.Add($u) } }
}
Write-Host "urls sharing a byte length (candidates to hash): $($suspectUrls.Count)"

$pool2 = [RunspaceFactory]::CreateRunspacePool(1, 12)
$pool2.Open()
$jobs2 = @()
foreach ($u in $suspectUrls) {
  $ps = [PowerShell]::Create()
  $ps.RunspacePool = $pool2
  [void]$ps.AddScript({
    param($url)
    try {
      $wc = New-Object Net.WebClient
      $wc.Headers.Add('User-Agent','optcg-quant-image-audit')
      $b = $wc.DownloadData($url)
      $md5 = [Security.Cryptography.MD5]::Create()
      $h = ($md5.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) -join ''
      return @{ url = $url; hash = $h }
    } catch { return @{ url = $url; hash = 'ERR' } }
  }).AddArgument($u)
  $jobs2 += [pscustomobject]@{ ps = $ps; handle = $ps.BeginInvoke() }
}
$hash = @{}
$done = 0
foreach ($j in $jobs2) {
  $r = $j.ps.EndInvoke($j.handle)
  $j.ps.Dispose()
  if ($r) { $hash[$r[0].url] = $r[0].hash }
  $done++
  if ($done % 100 -eq 0) { Write-Host "  hash $done/$($suspectUrls.Count)" }
}
$pool2.Close(); $pool2.Dispose()

# ---- 4. report: distinct cards served the same file -----------------------
$byHash = @{}
foreach ($kv in $hash.GetEnumerator()) {
  if ($kv.Value -eq 'ERR') { continue }
  if (-not $byHash.ContainsKey($kv.Value)) { $byHash[$kv.Value] = New-Object System.Collections.ArrayList }
  [void]$byHash[$kv.Value].Add($kv.Key)
}
$urlToCards = @{}
foreach ($c in $withArt) {
  $u = $c.card_image
  if (-not $urlToCards.ContainsKey($u)) { $urlToCards[$u] = New-Object System.Collections.ArrayList }
  [void]$urlToCards[$u].Add($c)
}

$report = New-Object System.Collections.ArrayList
foreach ($kv in $byHash.GetEnumerator()) {
  if ($kv.Value.Count -lt 2) { continue }
  $members = New-Object System.Collections.ArrayList
  foreach ($u in $kv.Value) {
    foreach ($c in $urlToCards[$u]) {
      [void]$members.Add([pscustomobject]@{
        set = $c.set_id; iid = $c.card_image_id; name = $c.card_name
        rar = $c.rarity; price = $c.market_price; url = $u
      })
    }
  }
  $names = ($members | ForEach-Object { $_.card_name } | Sort-Object -Unique)
  [void]$report.Add([pscustomobject]@{
    hash = $kv.Key; distinctNames = ($members | ForEach-Object { $_.name } | Sort-Object -Unique).Count
    members = $members
  })
}
$report = $report | Where-Object { $_.distinctNames -gt 1 }
Write-Host "=== duplicate-artwork clusters (different cards, identical file): $(@($report).Count) ==="
foreach ($g in $report) {
  Write-Host "--- $($g.hash.Substring(0,8))"
  foreach ($m in $g.members) { Write-Host "    $($m.set) $($m.iid) | $($m.name) [$($m.rar)] `$$($m.price)" }
}
$report | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 (Join-Path $here 'dupart.json')
$heads.GetEnumerator() | ForEach-Object { "$($_.Key)`t$($_.Value)" } | Out-File -Encoding utf8 (Join-Path $here 'heads.tsv')
Write-Host "written."
