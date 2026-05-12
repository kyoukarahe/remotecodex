param(
  [string]$HostId = "",
  [string]$DefaultOwnerHostId = "",
  [switch]$RegisterStartup
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Require-Command($Name, $InstallHint) {
  if (!(Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $InstallHint"
  }
}

function Require-AnyCommand($Names, $InstallHint) {
  foreach ($name in $Names) {
    if (Get-Command $name -ErrorAction SilentlyContinue) {
      return
    }
  }
  throw "$($Names -join ' or ') was not found. $InstallHint"
}

Require-Command "node" "Install Node.js LTS first."
Require-Command "npm.cmd" "Install Node.js LTS first."
Require-AnyCommand @("codex.cmd", "codex.exe", "codex") "Install and sign in to Codex CLI first."

if (!(Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Output "Created .env from .env.example"
}

$envLines = Get-Content ".env"
function Set-EnvValue($Key, $Value) {
  if (!$Value) {
    return
  }
  $script:envLines = $script:envLines | ForEach-Object {
    if ($_ -match "^$([regex]::Escape($Key))=") {
      "$Key=$Value"
    } else {
      $_
    }
  }
  if (-not ($script:envLines -match "^$([regex]::Escape($Key))=")) {
    $script:envLines += "$Key=$Value"
  }
}

Set-EnvValue "REMOTE_CODEX_HOST_ID" $HostId
Set-EnvValue "REMOTE_CODEX_DEFAULT_OWNER_HOST_ID" $DefaultOwnerHostId
$envLines | Set-Content ".env" -Encoding UTF8

if (Test-Path "package-lock.json") {
  npm.cmd ci --omit=dev
} else {
  npm.cmd install --omit=dev
}

if (!(Test-Path "dist\index.js")) {
  throw "dist\index.js was not found. Use a release package built by scripts\package-remotecodex.ps1."
}

if (!(Test-Path "output\logs")) {
  New-Item -ItemType Directory -Path "output\logs" -Force | Out-Null
}

if ($RegisterStartup) {
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-startup.ps1"
}

$envText = Get-Content ".env" -Raw
if ($envText -match "DISCORD_TOKEN=replace-me" -or $envText -match "DISCORD_GUILD_ID=replace-me") {
  Write-Warning ".env still has placeholder Discord settings. Edit .env before starting the bot."
}

Write-Output "RemoteCodex install completed."
Write-Output "Start manually with: scripts\start-remotecodex.bat"
