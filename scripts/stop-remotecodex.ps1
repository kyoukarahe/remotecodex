param(
  [string]$Root = ""
)

$ErrorActionPreference = "Stop"

if (!$Root) {
  $Root = Split-Path -Parent $PSScriptRoot
}

$resolvedRoot = (Resolve-Path $Root).Path
$escapedRoot = [regex]::Escape($resolvedRoot)
$targets = Get-CimInstance Win32_Process | Where-Object {
  $commandLine = $_.CommandLine
  if (!$commandLine) {
    return $false
  }

  $isRemoteCodexDev = $commandLine -match $escapedRoot -and $commandLine -match "tsx.*src[/\\]index\.ts"
  $isRemoteCodexStart = $commandLine -match "node\s+dist[/\\]index\.js"
  $isRemoteCodexNpm = $commandLine -match "npm-cli\.js.*\s(start|run dev)\b"
  return $isRemoteCodexDev -or $isRemoteCodexStart -or $isRemoteCodexNpm
}

foreach ($process in $targets) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    Write-Output "Stopped RemoteCodex process $($process.ProcessId): $($process.Name)"
  } catch {
    Write-Warning "Failed to stop process $($process.ProcessId): $($_.Exception.Message)"
  }
}
