# Generated from bootstrap.ps1 by scripts/sync-update-launchers.mjs; do not edit directly.
# A complete script block must arrive before Invoke-Expression can execute it.
& {
    $ErrorActionPreference = 'Stop'
    $forwardArgs = @('--update') + @($args)
    if ($forwardArgs -ccontains '--help' -or $forwardArgs -ccontains '-h') {
        Write-Output 'Usage: .\update.ps1 [update options]'
        Write-Output 'Updates an existing PayGo installation. Requires Node.js 20+ and Git. PAYGO_HOST selects the host; PAYGO_BRANCH overrides the installed branch.'
        Write-Output 'PAYGO_INSTALLER_REF selects the installer branch/tag (default: main).'
        $global:LASTEXITCODE = 0
        return
    }
    $tempDirectory = $null
    $tempBase = $null
    $tempCreated = $false
    $installerExit = $null
    try {
        $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'Node.js 20 or newer is required.' }
        $version = & $node.Source --version 2>$null
        if ($LASTEXITCODE -ne 0 -or "$version" -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20 or newer is required.' }
        $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $git) { throw 'Git is required.' }
        $installerRef = $env:PAYGO_INSTALLER_REF
        if ([string]::IsNullOrEmpty($installerRef)) { $installerRef = 'main' }
        if ($installerRef -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $installerRef.Contains('..')) { throw 'Invalid PAYGO_INSTALLER_REF.' }
        $tempBase = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'paygo-bootstrap'))
        [IO.Directory]::CreateDirectory($tempBase) | Out-Null
        if ((Get-Item -LiteralPath $tempBase).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe temporary directory.' }
        $tempDirectory = [IO.Path]::GetFullPath((Join-Path $tempBase ('run.' + [Guid]::NewGuid().ToString('N'))))
        New-Item -ItemType Directory -Path $tempDirectory | Out-Null
        $tempCreated = $true
        $source = Join-Path $tempDirectory 'source'
        # Capture clone diagnostics without exposing credential-bearing environment messages.
        Write-Host 'Downloading the PayGo updater...'
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $cloneOutput = & $git.Source clone --depth 1 --single-branch --branch $installerRef -- https://github.com/mananekoha114/ST-Vertex-PayGo.git $source 2>&1
        $cloneExit = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($cloneExit -ne 0) { throw 'Unable to download the PayGo installer.' }
        & $node.Source (Join-Path $source 'scripts/install-online.mjs') @forwardArgs
        $installerExit = $LASTEXITCODE
        $global:LASTEXITCODE = $installerExit
        if ($installerExit -ne 0) { throw "PayGo installer failed (exit $installerExit)." }
    } catch {
        if (-not $installerExit -or $installerExit -eq 0) { $global:LASTEXITCODE = 1 }
        throw
    } finally {
        if ($tempCreated -and $tempDirectory -and $tempBase) {
            $fullDirectory = [IO.Path]::GetFullPath($tempDirectory)
            $basePrefix = [IO.Path]::GetFullPath($tempBase).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if ($fullDirectory.StartsWith($basePrefix, [StringComparison]::OrdinalIgnoreCase) -and
                [IO.Path]::GetFileName($fullDirectory) -match '^run\.[0-9a-f]{32}$' -and
                (Test-Path -LiteralPath $fullDirectory)) {
                try {
                    Remove-Item -LiteralPath $fullDirectory -Recurse -Force
                } catch {
                    Write-Warning 'Unable to clean the temporary installer directory.'
                }
            }
        }
    }
} @args
