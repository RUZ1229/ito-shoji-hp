param(
  [int]$Port = 8765,
  [string]$Root = $PSScriptRoot,
  [switch]$OpenBrowser
)
$ErrorActionPreference = "Stop"
try {
  $Root = (Resolve-Path $Root).Path
  if (-not (Test-Path (Join-Path $Root "index.html") -PathType Leaf)) {
    throw "index.html が見つかりません。`n展開したフォルダの中（開く.bat と同じ場所）で実行してください。`n今の場所: $Root"
  }
  $http = [System.Net.HttpListener]::new()
  $added = $false
  foreach ($prefix in @("http://127.0.0.1:$Port/", "http://localhost:$Port/")) {
    try {
      $http.Prefixes.Add($prefix)
      $added = $true
    } catch { }
  }
  if (-not $added) { throw "ポート $Port を使えません。" }
  $http.Start()
  $url = "http://127.0.0.1:$Port/"
  Write-Host ""
  Write-Host "千葉配送地図サーバー起動中..."
  Write-Host "  $url"
  Write-Host "  この黒い画面は閉じないでください（閉じると地図が止まります）"
  Write-Host "  終了: このウィンドウを閉じる"
  Write-Host ""
  if ($OpenBrowser) { Start-Process $url }
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
} catch {
  Write-Host ""
  Write-Host "【エラー】地図を起動できませんでした。" -ForegroundColor Red
  Write-Host $_.Exception.Message
  Write-Host ""
  Write-Host "確認:"
  Write-Host "  1) zip を「すべて展開」したフォルダで実行"
  Write-Host "  2) 開く.bat と index.html が同じフォルダにあるか"
  Write-Host "  3) 社内ITに localhost:$Port の使用可否を確認"
  Read-Host "Enter で終了"
  exit 1
}
