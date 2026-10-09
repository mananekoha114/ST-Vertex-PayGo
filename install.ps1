# Installation logic lives in scripts/install.mjs. Keep all arguments intact.
$ErrorActionPreference = 'Stop'
$installerArgs = @($args)
$helpRequested = $installerArgs -ccontains '--help' -or $installerArgs -ccontains '-h'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeReady = $false
if ($nodeCommand) {
    $nodeVersion = & $nodeCommand.Source --version 2>$null
    if ($LASTEXITCODE -eq 0 -and "$nodeVersion" -match '^v(\d+)\.') {
        $nodeReady = [int]$Matches[1] -ge 20
    }
}
if (-not $nodeReady) {
    if ($helpRequested) {
        Write-Output "Usage: .\install.ps1 --host PATH [options]`nRequires an existing host environment and Node.js 20 or newer.`nOptions: --host PATH, --branch NAME, --local-source PATH, --config PATH,`n         --data-root PATH, --plugins-path PATH, --extensions-path PATH,`n         --replace-modified, --dry-run, --help"
        exit 0
    }
    [Console]::Error.WriteLine('Node.js 20 or newer is required; use the existing host environment.')
    exit 1
}
& $nodeCommand.Source (Join-Path $PSScriptRoot 'scripts/install.mjs') @installerArgs
exit $LASTEXITCODE
