# Updates the local Cramsesh server to the newest version on GitHub and restarts it.
# Run from the "Update Cramsesh" desktop shortcut that setup.ps1 creates.

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$task = 'LearnHarness'
$url = 'http://127.0.0.1:3000'
Set-Location $repo

function Fail($message) {
	Write-Host ''
	Write-Host $message -ForegroundColor Red
	Write-Host 'The server was not updated.' -ForegroundColor Red
	Enable-ScheduledTask $task | Out-Null
	Start-ScheduledTask $task
	Read-Host 'Press Enter to close'
	exit 1
}

Write-Host 'Getting the newest version from GitHub...'
$lockBefore = (Get-FileHash package-lock.json).Hash
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { Fail 'Could not get the newest version. Local changes or a different branch may be in the way.' }
$head = git rev-parse HEAD
$builtFile = '.next\BUILT_COMMIT'
$built = if (Test-Path $builtFile) { (Get-Content $builtFile -Raw).Trim() } else { '' }
$changed = $built -ne $head

Write-Host 'Stopping the server...'
# Disabled so the 5-minute relaunch can't start the old server in the middle of the build.
Disable-ScheduledTask $task | Out-Null
Stop-ScheduledTask $task
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
	ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

if ($changed) {
	if ((Get-FileHash package-lock.json).Hash -ne $lockBefore) {
		Write-Host 'Installing new dependencies...'
		npm ci --no-fund --no-audit
		if ($LASTEXITCODE -ne 0) { Fail 'Installing dependencies failed.' }
	}
	Write-Host 'Building (takes a minute or two)...'
	npm run build
	if ($LASTEXITCODE -ne 0) {
		# The first build after a pull often fails Next.js's security check; a second try passes.
		Write-Host 'Build failed, trying once more...'
		npm run build
		if ($LASTEXITCODE -ne 0) { Fail 'The build failed.' }
	}
	Set-Content $builtFile $head
} else {
	Write-Host 'Already on the newest version.'
}

Write-Host 'Starting the server...'
Enable-ScheduledTask $task | Out-Null
Start-ScheduledTask $task
for ($i = 0; $i -lt 60; $i++) {
	try {
		Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null
		Write-Host "Cramsesh is running the newest version ($(git log -1 --format=%s))." -ForegroundColor Green
		Start-Process $url
		Start-Sleep 3
		exit 0
	} catch { Start-Sleep 2 }
}
Write-Host 'The server did not come back within 2 minutes.' -ForegroundColor Red
Write-Host "Log: $env:LOCALAPPDATA\LearnHarnessAutostart\server.log"
Read-Host 'Press Enter to close'
exit 1
