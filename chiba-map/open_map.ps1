
$cfgPath = Join-Path $PSScriptRoot "data\update_config.json"
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.live_url) {
      Write-Host ""
      Write-Host "千葉配送地図（オンライン最新版）を開きます..."
      Write-Host "  $($cfg.live_url)"
      Write-Host "  ※ 機能追加後はブラウザ再読込(F5)だけで反映されます"
      Write-Host ""
      Start-Process $cfg.live_url
      Read-Host "Enter で終了"
      exit 0
    }
  } catch { }
}
param([int]$Port = 8766)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $PSScriptRoot).Path

if (-not (Test-Path (Join-Path $Root "index.html") -PathType Leaf)) {
  Write-Host ""
  Write-Host "index.html が見つかりません。"
  Write-Host "zip を展開したフォルダの中（開く.bat と同じ場所）で実行してください。"
  Write-Host "場所: $Root"
  Read-Host "Enter で終了"
  exit 1
}

function Test-PortOpen {
  try {
    $t = New-Object Net.Sockets.TcpClient
    $t.Connect("127.0.0.1", $Port)
    $t.Close()
    return $true
  } catch {
    return $false
  }
}

function Get-WorkingPython {
  foreach ($spec in @(
    @("py", @("-3")),
    @("py", @()),
    @("python", @()),
    @("python3", @())
  )) {
    $exe = $spec[0]
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
      $args = $spec[1] + @("-c", "import http.server; print('ok')")
      $out = & $exe @args 2>&1
      if ($LASTEXITCODE -eq 0 -and "$out" -match "ok") {
        return @{ Exe = $exe; Extra = $spec[1] }
      }
    } catch { }
  }
  return $null
}

function Start-PsServerJob {
  return Start-Job -Name "ChibaMapServer" -ScriptBlock {
    param($Port, $Root)
    $ErrorActionPreference = "Stop"
    $http = [System.Net.HttpListener]::new()
    $added = $false
    foreach ($prefix in @("http://127.0.0.1:$Port/", "http://localhost:$Port/")) {
      try { $http.Prefixes.Add($prefix); $added = $true } catch { }
    }
    if (-not $added) { throw "ポート $Port を使えません" }
    $http.Start()
    while ($http.IsListening) {
      $ctx = $http.GetContext()
      try {
        $rel = [Uri]::UnescapeDataString($ctx.Request.Url.LocalPath).TrimStart('/')
        if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
        $file = Join-Path $Root ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path $file -PathType Leaf)) {
          $ctx.Response.StatusCode = 404
        } else {
          $ext = [IO.Path]::GetExtension($file).ToLower()
          $ctx.Response.ContentType = switch ($ext) {
            '.html' { 'text/html; charset=utf-8' }
            '.js'   { 'application/javascript; charset=utf-8' }
            '.css'  { 'text/css; charset=utf-8' }
            '.json' { 'application/json; charset=utf-8' }
            '.geojson' { 'application/geo+json; charset=utf-8' }
            default { 'application/octet-stream' }
          }
          $bytes = [IO.File]::ReadAllBytes($file)
          $ctx.Response.ContentLength64 = $bytes.Length
          $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
      } finally {
        $ctx.Response.Close()
      }
    }
  } -ArgumentList $Port, $Root
}

function Start-PythonServer {
  param($PyInfo)
  $exe = $PyInfo.Exe
  $extra = ($PyInfo.Extra -join ' ')
  if ($extra) { $extra = "$extra " }
  $arg = "/c cd /d `"$Root`" && $extra$exe -m http.server $Port"
  Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WindowStyle Minimized | Out-Null
}

function Start-VisibleServer {
  $ps1 = Join-Path $Root "serve_windows.ps1"
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", $ps1, "-Port", $Port, "-Root", $Root, "-OpenBrowser"
  ) -WindowStyle Normal | Out-Null
}

function Wait-Port {
  param([int]$Seconds = 20)
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    if (Test-PortOpen) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Write-Host ""
Write-Host "千葉配送地図を起動しています..."

if (Test-PortOpen) {
  $url = "http://127.0.0.1:$Port/"
  Start-Process $url
  Write-Host "ブラウザで地図を開きました: $url"
  Read-Host "Enter で終了"
  exit 0
}

$job = Start-PsServerJob
if (Wait-Port) {
  $url = "http://127.0.0.1:$Port/"
  Start-Process $url
  Write-Host "サーバー起動完了 (PowerShell)。"
  Write-Host "ブラウザで地図を開きました: $url"
  Write-Host "終了: このウィンドウを閉じるとサーバーも止まります。"
  Read-Host "Enter で終了"
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  exit 0
}

if ($job.State -eq "Failed") {
  $err = Receive-Job $job 2>&1
  Write-Host "PowerShellサーバー: $err"
}
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue

$py = Get-WorkingPython
if ($py) {
  Start-PythonServer $py
  if (Wait-Port) {
    $url = "http://127.0.0.1:$Port/"
    Start-Process $url
    Write-Host "サーバー起動完了 (Python)。"
    Write-Host "ブラウザで地図を開きました: $url"
    Write-Host "終了: タスクバーのサーバーウィンドウを閉じる。"
    Read-Host "Enter で終了"
    exit 0
  }
}

Write-Host ""
Write-Host "自動起動できませんでした。"
Write-Host "→ 同じフォルダの「手動で開く.bat」をダブルクリックしてください。"
Write-Host "  （黒い画面を開いたまま地図が表示されます）"
Write-Host ""
$ans = Read-Host "今すぐ手動モードで起動しますか？ [Y/n]"
if ($ans -eq "" -or $ans -match "^[Yy]") {
  Start-VisibleServer
  Write-Host "サーバー画面を起動しました。地図が出ない場合はタスクバーを確認してください。"
  Read-Host "Enter で終了"
  exit 0
}

Write-Host ""
Write-Host "【エラー】サーバーが起動しませんでした（接続拒否）。"
Write-Host "  - 「手動で開く.bat」を実行"
Write-Host "  - 社内ITに localhost:$Port の使用可否を確認"
Read-Host "Enter で終了"
exit 1
