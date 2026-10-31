$ErrorActionPreference = 'Stop'
$env:CODEXPRO_BASH_RUNTIME = 'wsl'
Set-Location (Split-Path -Parent $PSScriptRoot)
& npm.cmd run smoke
exit $LASTEXITCODE
