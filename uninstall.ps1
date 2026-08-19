[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$AgentDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManagerPath = Join-Path $Root "scripts\profile-manager.mjs"
$ProfilePath = Join-Path $Root "profile.json"
if (-not $AgentDir) {
    $AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
}
$AgentDir = [System.IO.Path]::GetFullPath($AgentDir)
$StatePath = Join-Path $AgentDir "profile-state\pi-agent-config.json"

if (-not (Test-Path -LiteralPath $StatePath)) {
    Write-Host "Pi-agent-config is not installed in $AgentDir."
    exit 0
}

$Node = (Get-Command node.exe, node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
$Pi = (Get-Command pi.cmd, pi.exe, pi -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $Node) { throw "Node.js was not found on PATH." }
if (-not $Pi) { throw "Pi was not found on PATH." }

$State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
$Profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json

function Get-ManagedDirectoryHash {
    param([string]$Path)
    $result = & $Node $ManagerPath "hash-directory" "--root" $Root "--path" $Path | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $result.hash) { throw "Could not hash package directory: $Path" }
    return [string]$result.hash
}

if (-not $PSCmdlet.ShouldProcess($AgentDir, "Remove files and package settings owned by pi-agent-config")) {
    exit 0
}

$PreviousAgentDir = $env:PI_CODING_AGENT_DIR
$env:PI_CODING_AGENT_DIR = $AgentDir
try {
    & $Node $ManagerPath prepare --root $Root --agent-dir $AgentDir
    if ($LASTEXITCODE -ne 0) { throw "Could not back up the current Pi configuration." }

    foreach ($property in @($State.packages.PSObject.Properties)) {
        $record = $property.Value
        if ($record.created -ne $true) { continue }
        $packageDefinition = @($Profile.packages | Where-Object { $_.id -eq $property.Name } | Select-Object -First 1)
        if ($packageDefinition.Count -eq 1 -and $packageDefinition[0].PSObject.Properties.Name -contains "archive") {
            $archivePath = Join-Path $AgentDir ([string]$packageDefinition[0].archive.targetRelativePath)
            $markerPath = Join-Path $archivePath ".pi-agent-config-archive.json"
            if (Test-Path -LiteralPath $markerPath) {
                $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
                if ((Get-ManagedDirectoryHash -Path $archivePath) -ne [string]$marker.hash) {
                    Write-Warning "Modified archive package directory was preserved: $archivePath"
                    continue
                }
            }
        }
        Write-Host "Removing $($record.source)..." -ForegroundColor Cyan
        & $Pi remove ([string]$record.source) --no-approve
        if ($LASTEXITCODE -ne 0) {
            throw "Could not remove package $($record.source)."
        }
    }

    & $Node $ManagerPath uninstall --root $Root --agent-dir $AgentDir
    if ($LASTEXITCODE -ne 0) { throw "Could not finish profile configuration cleanup." }
} finally {
    $env:PI_CODING_AGENT_DIR = $PreviousAgentDir
}

Write-Host "Pi-agent-config uninstall completed." -ForegroundColor Green
Write-Host "Locally modified or pre-existing content was preserved."
