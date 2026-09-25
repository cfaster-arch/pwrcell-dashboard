<#
  PWRcell Dashboard - launcher (used by the "PWRcell Dashboard" scheduled task).
  Loads dashboard.env, then runs the production Nitro server.
#>
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $AppDir

$envFile = Join-Path $AppDir "dashboard.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*(.*)\s*$') {
      [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
    }
  }
}
if (-not $env:PORT) { $env:PORT = "8080" }
if (-not $env:NITRO_HOST) { $env:NITRO_HOST = "0.0.0.0" }

$server = Join-Path $AppDir ".output/server/index.mjs"
if (-not (Test-Path $server)) {
  # Production bundle missing (e.g. folder was copied without building) - build it.
  npm run build | Out-Null
}
& node $server
