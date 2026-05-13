param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [Parameter(Mandatory = $true)][string]$Branch,
  [Parameter(Mandatory = $true)][string]$DeployKeyPath,
  [Parameter(Mandatory = $true)][string]$StatusPath,
  [Parameter(Mandatory = $true)][string]$CommandChannelId,
  [Parameter(Mandatory = $true)][string]$HostId
)

$ErrorActionPreference = "Stop"

function Write-Status {
  param(
    [Parameter(Mandatory = $true)][string]$State,
    [string]$ErrorMessage = "",
    [string]$Commit = "",
    [string]$PreviousVersion = "",
    [string]$CurrentVersion = "",
    [string]$StartedAt = ""
  )

  $dir = Split-Path -Parent $StatusPath
  if (!(Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  [PSCustomObject]@{
    state = $State
    hostId = $HostId
    channelId = $CommandChannelId
    branch = $Branch
    commit = $Commit
    previousVersion = $PreviousVersion
    currentVersion = $CurrentVersion
    error = $ErrorMessage
    startedAt = $StartedAt
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $StatusPath -Encoding UTF8
}

function Resolve-Commit {
  try {
    return (git rev-parse --short HEAD).Trim()
  } catch {
    return "unknown"
  }
}

function Resolve-PackageVersion {
  try {
    $package = Get-Content "package.json" -Raw | ConvertFrom-Json
    return [string]$package.version
  } catch {
    return "unknown"
  }
}

try {
  $resolvedRoot = (Resolve-Path $Root).Path
  Set-Location $resolvedRoot
  $updateStartedAt = (Get-Date).ToUniversalTime().ToString("o")
  $previousVersion = Resolve-PackageVersion

  if (!(Test-Path "output\logs")) {
    New-Item -ItemType Directory -Force -Path "output\logs" | Out-Null
  }

  Write-Status -State "running" -Commit (Resolve-Commit) -PreviousVersion $previousVersion -CurrentVersion $previousVersion -StartedAt $updateStartedAt

  if (Test-Path $DeployKeyPath) {
    $env:GIT_SSH_COMMAND = "ssh -i `"$DeployKeyPath`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  }

  if (!(Test-Path ".git")) {
    git init
  }

  $existingRemote = ""
  try {
    $existingRemote = (git remote get-url origin 2>$null).Trim()
  } catch {
    $existingRemote = ""
  }

  if (!$existingRemote) {
    git remote add origin $RepoUrl
  } elseif ($existingRemote -ne $RepoUrl) {
    git remote set-url origin $RepoUrl
  }

  git fetch origin $Branch
  git reset --hard FETCH_HEAD
  npm.cmd ci
  npm.cmd run build

  $commit = Resolve-Commit
  $currentVersion = Resolve-PackageVersion
  Write-Status -State "succeeded" -Commit $commit -PreviousVersion $previousVersion -CurrentVersion $currentVersion -StartedAt $updateStartedAt
} catch {
  Write-Status -State "failed" -ErrorMessage $_.Exception.Message -Commit (Resolve-Commit) -PreviousVersion $previousVersion -CurrentVersion (Resolve-PackageVersion) -StartedAt $updateStartedAt
} finally {
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/d", "/s", "/c", "`"$Root\scripts\start-remotecodex.bat`"" `
    -WorkingDirectory $Root `
    -WindowStyle Hidden
}
