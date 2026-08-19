[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$AgentDir,
    [switch]$ValidateOnly,
    [switch]$SkipPrivateAccessCheck,
    [switch]$Repair,
    [switch]$ForceManagedUpdate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

if ($env:OS -ne "Windows_NT") {
    throw "Pi-agent-config currently supports Windows only."
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProfilePath = Join-Path $Root "profile.json"
$ManagerPath = Join-Path $Root "scripts\profile-manager.mjs"

if (-not $AgentDir) {
    if ($env:PI_CODING_AGENT_DIR) {
        $AgentDir = $env:PI_CODING_AGENT_DIR
    } else {
        $AgentDir = Join-Path $env:USERPROFILE ".pi\agent"
    }
}
$AgentDir = [System.IO.Path]::GetFullPath($AgentDir)

function Resolve-Executable {
    param([string[]]$Names, [string]$Description)
    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    throw "$Description was not found on PATH."
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
    }
}

function Install-ArchivePackage {
    param($Package)
    $result = & $Node $ManagerPath "install-archive" "--root" $Root "--agent-dir" $AgentDir "--package-id" ([string]$Package.id) "--git" $Git | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Could not install snapshot package $($Package.id)." }
    if ($result.status -eq "preserved") {
        Write-Warning "Snapshot package $($Package.id) was modified or unrecognized and was preserved."
    } else {
        Write-Host "$($Package.id): $($result.status) $($result.commit) ($($result.files) files)"
    }
}

$Node = Resolve-Executable -Names @("node.exe", "node") -Description "Node.js"
$NodeVersionText = (& $Node -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not determine the Node.js version." }
try { $NodeVersion = [version]$NodeVersionText } catch { throw "Node.js returned an invalid version: $NodeVersionText" }
if ($NodeVersion.Major -lt 20) {
    throw "Node.js 20 or newer is required; detected $NodeVersionText."
}
Invoke-Checked -Command $Node -Arguments @($ManagerPath, "validate", "--root", $Root)

if ($ValidateOnly) {
    Write-Host "Profile validation passed." -ForegroundColor Green
    exit 0
}

$Pi = Resolve-Executable -Names @("pi.cmd", "pi.exe", "pi") -Description "Pi"
$Git = Resolve-Executable -Names @("git.exe", "git") -Description "Git"
$Npx = Resolve-Executable -Names @("npx.cmd", "npx.exe", "npx") -Description "npx"

Invoke-Checked -Command $Npx -Arguments @("--version")

$EdgeCandidates = @(
    @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
)
$ChromeCandidates = @(
    @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
)

$Browser = if ($EdgeCandidates.Count -gt 0) { "msedge" } elseif ($ChromeCandidates.Count -gt 0) { "chrome" } else { "" }
$OutputDir = Join-Path $env:LOCALAPPDATA "Temp\pi-playwright-mcp"
$Profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json

$ManagerOptions = @("--root", $Root, "--agent-dir", $AgentDir, "--npx", $Npx, "--output-dir", $OutputDir)
if ($Browser) { $ManagerOptions += @("--browser", $Browser) }
if ($Repair -or $ForceManagedUpdate) { $ManagerOptions += "--repair" }
if ($ForceManagedUpdate) { $ManagerOptions += "--force-managed-update" }

if ($WhatIfPreference) {
    Invoke-Checked -Command $Node -Arguments (@($ManagerPath, "plan") + $ManagerOptions)
    exit 0
}

if (-not $SkipPrivateAccessCheck) {
    $PreviousTerminalPrompt = $env:GIT_TERMINAL_PROMPT
    $PreviousSshCommand = $env:GIT_SSH_COMMAND
    try {
        $env:GIT_TERMINAL_PROMPT = "0"
        $env:GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=8"
        foreach ($package in @($Profile.packages | Where-Object { $_.PSObject.Properties.Name -contains "private" -and $_.private -eq $true })) {
            Write-Host "Checking access to $($package.gitUrl)..."
            & $Git ls-remote --exit-code $package.gitUrl HEAD *> $null
            if ($LASTEXITCODE -ne 0) {
                throw "Cannot access private repository $($package.gitUrl). Configure a GitHub SSH key on this machine first."
            }
        }
    } finally {
        $env:GIT_TERMINAL_PROMPT = $PreviousTerminalPrompt
        $env:GIT_SSH_COMMAND = $PreviousSshCommand
    }
}

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$PreviousAgentDir = $env:PI_CODING_AGENT_DIR
$env:PI_CODING_AGENT_DIR = $AgentDir
try {
    Invoke-Checked -Command $Node -Arguments @($ManagerPath, "prepare", "--root", $Root, "--agent-dir", $AgentDir)

    foreach ($package in @($Profile.packages)) {
        if (-not $PSCmdlet.ShouldProcess($package.source, "Install or update Pi package")) { continue }
        Write-Host "Installing $($package.source)..." -ForegroundColor Cyan
        if ($package.PSObject.Properties.Name -contains "archive") {
            Install-ArchivePackage -Package $package
        } else {
            Invoke-Checked -Command $Pi -Arguments @("install", [string]$package.source, "--no-approve")
        }
    }

    Invoke-Checked -Command $Node -Arguments (@($ManagerPath, "apply") + $ManagerOptions)
    Invoke-Checked -Command $Node -Arguments @($ManagerPath, "verify", "--root", $Root, "--agent-dir", $AgentDir)
} finally {
    $env:PI_CODING_AGENT_DIR = $PreviousAgentDir
}

Write-Host "Pi Agent profile installation completed." -ForegroundColor Green
Write-Host "Agent directory: $AgentDir"
if (-not $Browser) {
    Write-Warning "No supported Edge or Chrome installation was detected; Playwright MCP was not configured."
}
Write-Host "Restart Pi or run /reload in an existing TUI session."
