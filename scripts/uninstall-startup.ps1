$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = Join-Path $startupDir "RemoteCodex Bot.lnk"

if (Test-Path $shortcutPath) {
  Remove-Item $shortcutPath -Force
  Write-Output "Startup shortcut removed: $shortcutPath"
} else {
  Write-Output "Startup shortcut not found: $shortcutPath"
}
