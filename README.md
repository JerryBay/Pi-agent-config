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
.\install.ps1 -SkipPrivateAccessCheck
.\install.ps1 -AgentDir C:\Temp\pi-agent-test
```

`-SkipPrivateAccessCheck` skips only the explicit `git ls-remote` preflight. Git access is still required by `pi install`.

## What It Installs

Remote Pi packages:

```text
git:git@github.com:JerryBay/Pi-agent-config.git
git:git@github.com:JerryBay/codex-workflow-profile.git
git:github.com/tmustier/pi-extensions
npm:pi-mcp-adapter
npm:pi-web-access
npm:@tintinweb/pi-subagents
npm:pi-btw
npm:pi-hermes-memory
```

The `tmustier/pi-extensions` package is filtered to load only `files-widget`, `usage-extension`, and `raw-paste` extensions. Its Agent Skills remain available through the same package.

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
- A local `codex-workflow-profile` Pi package source is migrated to its private Git source; the local repository is not deleted.
- Matching legacy copies of `windows-notify` and the Playwright setup skill are moved out of auto-discovery into the profile backup area, preventing duplicate commands and skills.
- If a legacy resource differs, it is preserved and the corresponding resource in the new package is filtered out.
- Backups and ownership state are stored under `PI_CODING_AGENT_DIR\profile-state`.

## Playwright MCP

The installer detects a working `npx.cmd` and an installed Edge or Chrome channel. It then creates a lazy, isolated Playwright DOM server with bounded output and image responses disabled. The `@playwright/mcp` version is pinned in `profile.json` because its command-line options are a tested integration contract.

An existing `playwright` MCP server is preserved unless it was created by this installer and has not been modified.

## Not Managed

The profile deliberately excludes:

```text
models.json and model/provider defaults
presets and the preset extension
API keys, OAuth credentials, and auth files
sessions, trust decisions, logs, caches, and memory data
shell, Node, npm, browser, and user-specific absolute paths
Playwright visual/image mode
```

## Uninstall

```powershell
.\uninstall.ps1
```

Uninstall removes only package settings and files created by this profile. Adopted, pre-existing, or locally modified content is preserved. A migrated local workflow package source is restored when the path still exists.

## Development

```powershell
npm test
npm run validate
```

Tests use temporary agent directories and do not modify the real Pi configuration.

## Security

Pi packages and extensions execute with the user's full system permissions. `profile.json` is the source allowlist; review changes to package links, filters, and installer scripts before running an updated profile. The installer records resolved npm versions and Git commits in its state file for audit and troubleshooting.
