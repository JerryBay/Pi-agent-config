# Design

## Goal

Provide one repeatable Windows installer for a portable Pi Agent workflow. The installer obtains skills and extensions from their owning Git or npm package, preserves unrelated local configuration, and generates only machine-dependent values locally.

## Ownership

- `codex-workflow-profile` owns the shared `AGENTS.md` and personal engineering skills.
- `pi-agent-config` owns the Windows notification and preset extensions, portable preset defaults, Playwright setup skill, package manifest, installer, and generated configuration policy.
- Third-party repositories own their own Pi packages; this repository stores only their source links and filters.
- The target machine owns models, provider credentials, sessions, trust decisions, paths, and persistent memory data.

## Update Policy

Unversioned Git and npm package sources obtain their current upstream version when the installer runs. The Playwright MCP version remains pinned because its command-line arguments are an integration contract. `@tmustier/pi-raw-paste` is pinned at `0.1.3` because the `/paste` command and `Alt+P` shortcut are a user-facing interaction contract. The installer records resolved sources and hashes so later runs can update installer-owned, unmodified content and preserve user modifications.

`tmustier/pi-extensions` is acquired as a commit-addressed selective snapshot because full Git clones stall in the supported Windows environment. The installer reads the GitHub commit tree and downloads only the enabled extensions, skills, and their support files; large demos, screenshots, and the separately installed `raw-paste` source are excluded. Its Pi package source remains declared in settings, while the installer records the resolved commit and a content hash so modified snapshots are preserved.

## Merge Rules

- Existing scalar settings win; defaults fill missing properties only.
- Existing package entries are preserved unless an explicit legacy local source is migrated to its configured remote source.
- Package filters are applied to entries created by this profile, or temporarily to pre-existing entries when needed to prevent duplicate resources; subsequent local modifications are preserved.
- An existing `AGENTS.md` is adopted only when it matches the configured source; otherwise it is preserved as a conflict.
- Existing MCP servers are preserved unless they match the generated profile server and can be adopted.
- Missing managed content is treated as a local removal during normal installation; `-Repair` recreates it without overriding modified content.
- `-ForceManagedUpdate` implies repair and replaces modified content only when prior ownership is proven by state.
- Matching legacy extension/skill directories are moved into the profile backup area to prevent duplicate auto-discovery; differing directories remain in place and disable only the corresponding packaged resource.
- Every changed user file is backed up before the first write in an install run.

## Preset Policy

The preset extension loads defaults from the package-level `presets.json`, then overlays `~/.pi/agent/presets.json` and project-local `.pi/presets.json`. Installing the extension does not select a preset or change the active model. Selecting a preset whose model is unavailable emits a warning but still applies its thinking level and instructions.

## Exclusions

The profile does not manage `models.json`, provider/model defaults, user preset overrides, API keys, OAuth credentials, sessions, `trust.json`, memory databases, logs, caches, shell paths, browser paths, or Node/npm paths.

## Verification

Tests use a temporary `PI_CODING_AGENT_DIR` and fixture package checkout. They cover clean installation, repeated installation, managed updates, repair, forced managed updates, preservation of unrelated settings, precise uninstall, legacy migration, and conflict handling. A real private-package install additionally requires GitHub SSH access and a fresh Pi process or `/reload`.
