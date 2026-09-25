<#
  PWRcell Dashboard - Windows one-shot installer
  Run: right-click -> "Run with PowerShell" (as Administrator for the
  firewall + power-settings steps; it will re-ask if not elevated).
#>
$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Host "Re-launching as Administrator..." -ForegroundColor Yellow
  Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
  exit
}

Write-Host "`n=== PWRcell Dashboard installer ===`n" -ForegroundColor Cyan

# 1. Node.js ---------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Host "Node found: $(node --version)"
} else {
  Write-Host "Installing Node.js LTS via winget (this takes a few minutes)..."
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path", "User")
  Write-Host "Node installed: $(node --version)"
}

# 2. Dependencies + production build ----------------------------------------
Write-Host "`nInstalling dependencies..."
npm install
Write-Host "`nBuilding production bundle..."
npm run build

# 3. Credentials (optional - without them the dashboard runs in demo mode) --
$envFile = Join-Path $AppDir "dashboard.env"
$email = Read-Host "PWRview email (Enter to skip - dashboard will run in DEMO mode)"
$password = ""
if ($email) {
  $sec = Read-Host "PWRview password" -AsSecureString
  $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
@(
  "GENERAC_EMAIL=$email",
  "GENERAC_PASSWORD=$password",
  "PORT=8080",
  "NITRO_HOST=0.0.0.0"
) | Set-Content $envFile
Write-Host "Wrote $envFile"

# 4. Firewall ---------------------------------------------------------------
Write-Host "`nOpening TCP 8080 in Windows Firewall..."
New-NetFirewallRule -DisplayName "PWRcell Dashboard" -Direction Inbound `
  -Protocol TCP -LocalPort 8080 -Action Allow -ErrorAction SilentlyContinue | Out-Null

# 5. Never sleep while plugged in -------------------------------------------
Write-Host "Disabling sleep while plugged in (laptop must stay awake)..."
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
# Lid close -> do nothing while on AC power
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

# 6. Auto-start on logon -----------------------------------------------------
$taskName = "PWRcell Dashboard"
$startScript = Join-Path $AppDir "start-dashboard.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "PWRcell solar dashboard backend" | Out-Null
Write-Host "Scheduled task '$taskName' created (starts at logon, restarts on failure)."

# 7. Launch now --------------------------------------------------------------
Write-Host "`nStarting dashboard..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep 8

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1 -ExpandProperty IPAddress)
Write-Host "`nDone! Dashboard should now be live at:" -ForegroundColor Green
Write-Host "  http://localhost:8080          (on this laptop)"
Write-Host "  http://${lanIp}:8080  (from the Fire tablet on the same Wi-Fi)"
Write-Host "`nPut that second URL in Fully Kiosk as the start page." -ForegroundColor Cyan
if (-not $email) {
  Write-Host "`nNOTE: no PWRview credentials were entered, so it runs in DEMO mode." -ForegroundColor Yellow
  Write-Host "Edit dashboard.env later with the real login, then restart the '$taskName' task."
}
