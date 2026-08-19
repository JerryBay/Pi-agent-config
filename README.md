# Pi Agent Config

Portable, repeatable Windows configuration for Pi Agent. The repository installs current skills and extensions from their owning Git or npm sources, preserves unrelated local settings, and generates machine-specific MCP paths during installation.

## Requirements

- Windows 10 or Windows 11
- Windows PowerShell 5.1 or newer
- Pi Agent
- Node.js 20 or newer and `npx.cmd`
- Git
- A GitHub SSH key with access to:
  - `git@github.com:JerryBay/Pi-agent-config.git`
  - `git@github.com:JerryBay/codex-workflow-profile.git`
  - Public-repository access over SSH to `git@github.com:tmustier/pi-extensions.git`

## Install

Clone this private repository, then run one command:

```powershell
.\install.ps1
```

Existing Pi sessions must run `/reload` or restart after installation.

Useful modes:

```powershell
.\install.ps1 -WhatIf
.\install.ps1 -ValidateOnly
.\install.ps1 -Repair
.\install.ps1 -ForceManagedUpdate
.\install.ps1 -SkipPrivateAccessCheck
.\install.ps1 -AgentDir C:\Temp\pi-agent-test
```

`-Repair` recreates profile-managed files, defaults, and MCP entries that were removed after installation, while still preserving modified content. `-ForceManagedUpdate` implies repair and replaces locally modified content only when the state file proves that the installer previously created or adopted it; unrelated or never-owned content is still preserved.

`-SkipPrivateAccessCheck` skips only the explicit `git ls-remote` preflight. Git access is still required by `pi install`.

## What It Installs

Remote Pi packages:

```text
git:git@github.com:JerryBay/Pi-agent-config.git
git:git@github.com:JerryBay/codex-workflow-profile.git
git:git@github.com:tmustier/pi-extensions.git
npm:pi-mcp-adapter
npm:pi-web-access
npm:@tintinweb/pi-subagents
npm:pi-btw
npm:pi-hermes-memory
npm:@tmustier/pi-raw-paste@0.1.3
```

The `tmustier/pi-extensions` package is filtered to load only `files-widget` and `usage-extension`; its three Agent Skills remain available through the same package. Because full Git clones of this repository can stall in the target Windows Git environment, the installer resolves `HEAD` over SSH, reads the commit tree, and downloads only the enabled extensions and skills from that exact commit. Large demos, screenshots, and the separately packaged `raw-paste` source are excluded. The installer records the commit and directory hash, and updates the snapshot only while the installed directory remains unmodified.

`raw-paste` is installed separately at `npm:@tmustier/pi-raw-paste@0.1.3`. This version is pinned because the `/paste` command and `Alt+P` shortcut are part of the portable interaction contract.

The selective snapshot intentionally has no `.git` directory. Update it by rerunning `install.ps1`; do not run a standalone `pi update` for this package source.

The private workflow package supplies the shared `AGENTS.md` and these Agent Skills:

```text
architecture-aware-development
design-first-project-planning
evidence-first-local-debugging
local-repo-orientation
minimal-scope-repo-change
windows-gui-dev-workflow
```

This repository supplies:

```text
windows-notify extension
preset extension and portable quick/deep/review/research/minimal defaults
configure-playwright-mcp-windows skill
Windows installer and ownership state
Playwright DOM MCP configuration policy
```

## Merge and Update Behavior

- Package sources without a version follow the latest npm release or Git default branch when this installer runs.
- Only package sources listed in `profile.json` are installed or updated.
- Existing scalar settings win; profile defaults fill missing values only.
- Existing `AGENTS.md` and MCP servers are never overwritten when their content differs.
- Files adopted or created by this installer update only while their recorded hash still matches.
- Removing managed files or settings is treated as a local change; use `-Repair` to recreate them.
- Modifying managed content is preserved and reported as a conflict; `-ForceManagedUpdate` explicitly restores the profile version.
- A local `codex-workflow-profile` Pi package source is migrated to its private Git source; the local repository is not deleted.
- The legacy `git:github.com/tmustier/pi-extensions` source is migrated to SSH because HTTPS access can stall in some Windows Git environments; the previous entry is restored by uninstall when unchanged.
- The unpinned `npm:@tmustier/pi-raw-paste` source is migrated to the tested `0.1.3` package and restored by uninstall when unchanged.
- Matching legacy copies of `windows-notify`, `preset`, and the Playwright setup skill are moved out of auto-discovery into the profile backup area, preventing duplicate commands and skills.
- If a legacy resource differs, it is preserved and only the corresponding packaged resource is filtered out.
- Backups and ownership state are stored under `PI_CODING_AGENT_DIR\profile-state`.

## Presets

The preset extension is installed but does not activate a preset automatically. It loads the portable defaults from this package first, then overlays `~/.pi/agent/presets.json` and project-local `.pi/presets.json` when present. Use `/preset` to select one, or `Ctrl+Shift+U` to cycle through them.

A target machine without the configured GPT model starts and operates normally. Selecting one of these presets shows a missing-model or missing-key warning; the preset's thinking level and instructions still apply to the current model.

## Playwright MCP

The installer detects a working `npx.cmd` and an installed Edge or Chrome channel. It then creates a lazy, isolated Playwright DOM server with bounded output and image responses disabled. The `@playwright/mcp` version is pinned in `profile.json` because its command-line options are a tested integration contract.

An existing `playwright` MCP server is preserved unless it was created by this installer and has not been modified.

## Not Managed

The profile deliberately excludes:

```text
models.json and model/provider defaults
user-defined global and project preset overrides
API keys, OAuth credentials, and auth files
sessions, trust decisions, logs, caches, and memory data
shell, Node, npm, browser, and user-specific absolute paths
Playwright visual/image mode
```

## Uninstall

```powershell
.\uninstall.ps1
```

Uninstall removes only package settings and files created by this profile. Adopted, pre-existing, or locally modified content is preserved. Migrated local workflow and legacy Git package sources are restored when their recorded replacement remains unchanged.

## Development

```powershell
npm test
npm run validate
```

Tests use temporary agent directories and do not modify the real Pi configuration.

## Security

Pi packages and extensions execute with the user's full system permissions. `profile.json` is the source allowlist; review changes to package links, filters, and installer scripts before running an updated profile. The installer records resolved npm versions and Git commits in its state file for audit and troubleshooting.
