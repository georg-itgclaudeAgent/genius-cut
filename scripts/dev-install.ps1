<#
.SYNOPSIS
  Link this repo's extension/ folder into Premiere's CEP extensions folder, so rebuilds
  (`npm run watch` in extension/client) show up without reinstalling.

.DESCRIPTION
  Creates a directory junction:
    %APPDATA%\Adobe\CEP\extensions\com.attract.genius-cut  ->  <repo>\extension
  A junction needs no admin rights or Developer Mode, unlike a symlink.

  Refuses to touch the target if it's a real folder (for example a copy installed by
  Genius Installer Manager). While the link exists, don't install Genius Cut from the
  installer: both use the same folder. Remove the link first with -Remove.

  Premiere must be restarted to pick up a new or removed extension.

.EXAMPLE
  .\scripts\dev-install.ps1
  .\scripts\dev-install.ps1 -Remove
#>
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$bundleId = "com.attract.genius-cut"
$source = Join-Path (Split-Path -Parent $PSScriptRoot) "extension"
$target = Join-Path $env:APPDATA "Adobe\CEP\extensions\$bundleId"

function Test-Link([string]$path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

if ($Remove) {
    if (-not (Test-Path -LiteralPath $target)) { Write-Host "Nothing to remove: $target doesn't exist."; exit 0 }
    if (-not (Test-Link $target)) {
        Write-Error "$target is a real folder, not a dev link. Uninstall it from Genius Installer Manager instead."
    }
    # Removing a junction deletes the link only, never the repo files it points to.
    [IO.Directory]::Delete($target)
    Write-Host "Removed dev link $target. Restart Premiere."
    exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $source "CSXS\manifest.xml"))) {
    Write-Error "No extension found at $source."
}
if (-not (Test-Path -LiteralPath (Join-Path $source "client\dist\index.html"))) {
    Write-Warning "extension\client\dist is missing. Run 'npm run build' in extension\client first."
}

if (Test-Path -LiteralPath $target) {
    if (Test-Link $target) {
        Write-Host "Dev link already in place: $target"
        exit 0
    }
    Write-Error "$target already exists and is a real install. Remove it from Genius Installer Manager first; this script won't overwrite it."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
New-Item -ItemType Junction -Path $target -Target $source | Out-Null

# Unsigned CEP extensions only load with PlayerDebugMode on (the installer sets this too).
New-Item -Path "HKCU:\Software\Adobe\CSXS.12" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.12" -Name "PlayerDebugMode" -Value "1"

Write-Host "Linked $target -> $source"
Write-Host "Restart Premiere, then open Window > Extensions > Genius Cut."
