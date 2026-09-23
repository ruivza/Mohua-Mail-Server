$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$mohuaNode = Get-Command node -ErrorAction SilentlyContinue
if ($mohuaNode) {
    $mohuaRuntime = $mohuaNode.Source
} else {
    $mohuaRuntime = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $mohuaRuntime)) { throw 'Node.js 24 or newer is required. Install Node.js and run this script again.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\imapflow'))) { throw 'Dependencies missing. Run npm ci first.' }
Write-Host 'Mohua: http://127.0.0.1:3210 -- Ctrl+C to stop'
& $mohuaRuntime (Join-Path $PSScriptRoot 'src\server.js')
