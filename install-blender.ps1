[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$AgentDir, [string]$BlenderPath, [string]$PythonPath = "python.exe")

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $AgentDir) {
    $AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
}
$AgentDir = [IO.Path]::GetFullPath($AgentDir)
$ConfigPath = Join-Path $AgentDir "mcp.json"
if (Test-Path -LiteralPath $ConfigPath) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.PSObject.Properties.Name -contains "mcpServers" -and $config.mcpServers.PSObject.Properties.Name -contains "blender") {
        Write-Host "Existing Blender MCP configuration preserved; no installation performed."
        return
    }
}
if (-not $BlenderPath) {
    $command = Get-Command blender.exe -ErrorAction SilentlyContinue
    if ($command) { $BlenderPath = $command.Source }
}
if (-not $BlenderPath -or -not (Test-Path -LiteralPath $BlenderPath -PathType Leaf)) {
    throw "Provide -BlenderPath pointing to an installed Blender 5.1+ blender.exe."
}
$BlenderPath = (Resolve-Path -LiteralPath $BlenderPath).Path
if ($env:BLENDER_USER_RESOURCES -or $env:BLENDER_USER_CONFIG -or (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $BlenderPath) "portable"))) {
    throw "Custom or portable Blender configuration is not supported; install the extension manually."
}
$versionText = (& $BlenderPath --version | Out-String)
if ($LASTEXITCODE -ne 0 -or $versionText -notmatch 'Blender (\d+\.\d+)') { throw "Cannot determine Blender version." }
$BlenderVersion = $Matches[1]
if ([version]$BlenderVersion -lt [version]"5.1") { throw "Blender 5.1 or newer is required." }
$Preferences = Join-Path $env:APPDATA "Blender Foundation\Blender\$BlenderVersion\config\userpref.blend"
$ExistingAddon = Join-Path $env:APPDATA "Blender Foundation\Blender\$BlenderVersion\extensions\user_default\mcp"
if (Test-Path -LiteralPath $ExistingAddon) { throw "Existing Blender MCP extension preserved; configure it manually instead of overwriting it." }
if (Get-Process blender -ErrorAction SilentlyContinue) { throw "Close Blender before installing its MCP extension." }
& $PythonPath -c "import sys; assert sys.version_info >= (3,10), 'Python 3.10+ required'"
if ($LASTEXITCODE -ne 0) { throw "A working Python 3.10+ is required; use -PythonPath." }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Curl = (Get-Command curl.exe -ErrorAction Stop).Source
$ToolDir = Join-Path $AgentDir "tools\blender-lab-mcp-1.0.0"
if (Test-Path -LiteralPath $ToolDir) { throw "Existing tool directory preserved: $ToolDir. Inspect it before retrying a partial installation." }
if (-not $PSCmdlet.ShouldProcess($AgentDir, "Install official Blender Lab MCP 1.0.0, enable Blender extension and configure Pi")) { return }

New-Item -ItemType Directory -Path $ToolDir -Force | Out-Null
$Assets = @(
    @{ Name = "blender-1.0.0.mcpb"; Hash = "93B070B1DF82F57B1E7678B88B6BAE28D06F105CD23FF6A4E0CC5F538BEE2450" },
    @{ Name = "mcp-1.0.0.zip"; Hash = "838C3449F01015C861290658AE67F122F0846F7882F60A5DFDA0EF7E6A9B8403" }
)
foreach ($asset in $Assets) {
    $destination = Join-Path $ToolDir $asset.Name
    & $Curl -fSL --retry 3 --connect-timeout 20 --max-time 300 "https://projects.blender.org/lab/blender_mcp/releases/download/v1.0.0/$($asset.Name)" -o $destination
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $($asset.Name)" }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $asset.Hash) { throw "Release checksum mismatch: $($asset.Name)" }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ServerDir = Join-Path $ToolDir "server"
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $ToolDir "blender-1.0.0.mcpb"), $ServerDir)
$Venv = Join-Path $ToolDir "venv"
& $PythonPath -m venv $Venv
if ($LASTEXITCODE -ne 0) { throw "Could not create dedicated Python environment." }
$Python = Join-Path $Venv "Scripts\python.exe"
& $Python -m pip install $ServerDir "mcp[cli]==1.27.0"
if ($LASTEXITCODE -ne 0) { throw "Could not install official Blender MCP server." }
& $Python -m pip check
if ($LASTEXITCODE -ne 0) { throw "Blender MCP dependency check failed." }
if (Test-Path -LiteralPath $Preferences) {
    Copy-Item -LiteralPath $Preferences -Destination (Join-Path $ToolDir "userpref.before-mcp.blend")
}
& $BlenderPath --background --command extension install-file -r user_default -e (Join-Path $ToolDir "mcp-1.0.0.zip")
if ($LASTEXITCODE -ne 0) { throw "Blender extension installation failed; preferences backup is in $ToolDir." }
& $BlenderPath --background --python-exit-code 1 --python-expr "import bpy; assert bpy.context.preferences.addons.get('bl_ext.user_default.mcp'), 'MCP extension not enabled'"
if ($LASTEXITCODE -ne 0) { throw "Blender MCP extension verification failed." }
& $Node (Join-Path $Root "scripts\profile-manager.mjs") configure-blender --root $Root --agent-dir $AgentDir --python $Python --blender $BlenderPath
if ($LASTEXITCODE -ne 0) { throw "Could not configure Blender MCP in Pi." }
Write-Host "Installed. Start Blender with --online-mode for MCP, then /reload Pi and connect blender."
Write-Host "Global online access and automatic script execution preferences were not enabled."
Write-Host "Uninstall removes unchanged profile-created MCP configuration only; Blender extension and tools are retained."
