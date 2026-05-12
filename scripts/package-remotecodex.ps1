$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot "output\package-stage\remotecodex"
$packageDir = Join-Path $repoRoot "output\packages"
$zipPath = Join-Path $packageDir "remotecodex-0.1.0.zip"

Set-Location $repoRoot
npm.cmd run build

if (Test-Path $packageRoot) {
  Remove-Item $packageRoot -Recurse -Force
}
if (!(Test-Path $packageDir)) {
  New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
}
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

$items = @(
  "dist",
  "scripts",
  "src",
  "package.json",
  "package-lock.json",
  "README.md",
  "tsconfig.json",
  ".env.example",
  "install-remotecodex.bat"
)

foreach ($item in $items) {
  $source = Join-Path $repoRoot $item
  if (Test-Path $source) {
    Copy-Item $source $packageRoot -Recurse -Force
  }
}

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}
Compress-Archive -Path (Join-Path $packageRoot "*") -DestinationPath $zipPath -Force

Write-Output "Package created: $zipPath"
