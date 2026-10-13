<#
.SYNOPSIS
  Register the Genius Cut assistant's tools (premiere-mcp) with Claude Code, for this user.

.DESCRIPTION
  Personal builds only. Adds a user-scope MCP server named "premiere" that runs
  `node <this checkout>\mcp\premiere-mcp.mjs`. The tools work only while the Genius Cut panel,
  built with VITE_GENIUSCUT_CLAUDE=1, is open in Premiere.

  Idempotent: removes any existing "premiere" registration first, then adds it again, so it is
  safe to re-run (for example after moving the checkout).

  Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\register-claude.ps1
#>

$repo = Split-Path -Parent $PSScriptRoot
$mcp = Join-Path $repo "mcp\premiere-mcp.mjs"
if (-not (Test-Path -LiteralPath $mcp)) {
    Write-Error "Can't find $mcp. Run this script from inside the genius-cut checkout (scripts\register-claude.ps1)."
    exit 1
}
$mcp = (Resolve-Path -LiteralPath $mcp).Path

# Claude Code: on PATH, else the default install location.
$claude = $null
$cmd = Get-Command claude -ErrorAction SilentlyContinue
if ($cmd) { $claude = $cmd.Source }
elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE ".local\bin\claude.exe")) { $claude = Join-Path $env:USERPROFILE ".local\bin\claude.exe" }
if (-not $claude) {
    Write-Error "Claude Code isn't installed (no 'claude' on PATH or in $env:USERPROFILE\.local\bin). Install it and sign in first."
    exit 1
}

# premiere-mcp needs Node 20+ (built-in fetch), started as `node` by Claude Code.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js isn't on PATH. Install Node 20 or newer, then run this again."
    exit 1
}
$nodeMajor = [int](((& node --version) -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Error "premiere-mcp needs Node 20 or newer; 'node' is v$nodeMajor."
    exit 1
}

# Idempotent: drop any earlier registration (it's fine if there was none).
& $claude mcp remove premiere --scope user *> $null

& $claude mcp add --scope user premiere -- node $mcp
if ($LASTEXITCODE -ne 0) {
    Write-Error "claude mcp add failed (exit $LASTEXITCODE)."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Registered 'premiere' for Claude Code (user scope): node $mcp"
Write-Host "Check it:   claude mcp list"
Write-Host "Use it:     open the Genius Cut panel (assistant build) in Premiere, then ask Claude Code."
Write-Host "Remove it:  claude mcp remove premiere --scope user"
