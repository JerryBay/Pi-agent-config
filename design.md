# Design

## Goal

Provide one repeatable Windows installer for a portable Pi Agent workflow. The installer obtains skills and extensions from their owning Git or npm package, preserves unrelated local configuration, and generates only machine-dependent values locally.

## Ownership

- `codex-workflow-profile` owns the shared `AGENTS.md` and personal engineering skills.
- `pi-agent-config` owns the Windows notification, preset, and terminal-title extensions, portable preset and keybinding defaults, the pinned Pi Web companion installation, Playwright setup skill, package manifest, installer, and generated configuration policy.
- Third-party repositories own their own Pi packages; this repository stores only their source links and filters.
- The target machine owns models, provider credentials, sessions, trust decisions, paths, and persistent memory data.

## Update Policy

Unversioned Git and npm Pi package sources obtain their current upstream version when the installer runs. The Playwright MCP version remains pinned because its command-line arguments are an integration contract. The global `@agegr/pi-web` companion is pinned at `0.8.9` because it embeds a matching Pi runtime and requires a specific Node.js baseline. The installer records resolved sources, versions, and hashes so later runs can update installer-owned, unmodified content and preserve user modifications.

## Merge Rules

- Existing scalar settings win; defaults fill missing properties only.
- Existing package entries are preserved unless an explicit legacy local source is migrated to its configured remote source.
- Package filters are applied to entries created by this profile, or temporarily to pre-existing entries when needed to prevent duplicate resources; subsequent local modifications are preserved.
- An existing `AGENTS.md` or `keybindings.json` is adopted only when it matches the configured source; otherwise it is preserved as a conflict.
- Existing MCP servers are preserved unless they match the generated profile server and can be adopted.
- Missing managed content is treated as a local removal during normal installation; `-Repair` recreates it without overriding modified content.
- `-ForceManagedUpdate` implies repair and replaces modified content only when prior ownership is proven by state.
- Matching legacy extension files/directories and skill directories are moved into the profile backup area to prevent duplicate auto-discovery; differing resources remain in place and disable only the corresponding packaged resource.
- Every changed user file is backed up before the first write in an install run.

## Preset Policy

The preset extension loads defaults from the package-level `presets.json`, then overlays `~/.pi/agent/presets.json` and project-local `.pi/presets.json`. Installing the extension does not select a preset or change the active model. Selecting a preset whose model is unavailable emits a warning but still applies its thinking level and instructions.

## Keybinding Policy

The package owns the portable message-routing defaults in `keybindings.json`: `Enter` uses the follow-up action, `Ctrl+Enter` uses ordinary submit/steer, and Pi's default `Shift+Enter`/`Ctrl+J` bindings continue to insert newlines. The installer treats the file like other managed content and does not overwrite a pre-existing differing file.

## Companion Tools

`@agegr/pi-web` is a standalone global npm application rather than a Pi package. The installer manages its pinned version separately from `settings.json`: a missing installation is created, a matching installation is adopted, and an unowned differing version is preserved. State records whether the profile created or adopted it, allowing uninstall to remove only unchanged profile-created installations. `-SkipGlobalNpmTools` leaves the global npm environment untouched and retains Node.js 20 compatibility for the core profile; otherwise Node.js 22.19 or newer is required.

## Optional Blender Integration

`install-blender.ps1`, optionally invoked by `install.ps1 -WithBlender`, installs the checksum-pinned official Blender Lab v1.0.0 assets into a dedicated Python environment and enables the Blender extension. Blender and Python are prerequisites, not installed by the profile. Executable paths are supplied or resolved locally. Existing MCP entries, extension directories and tool directories are not overwritten. The installer supports standard Blender user configuration only and requires Blender to be closed.

Only the new MCP entry enters profile ownership; normal uninstall preserves modified entries and retains Blender-side files and the Python environment. Loopback networking and tool approvals are configured without changing global Blender online-access or script-execution preferences. No Blender skill is bundled.

## Exclusions

The profile does not manage `models.json`, provider/model defaults, user preset overrides, API keys, OAuth credentials, sessions, `trust.json`, memory databases, logs, caches, shell paths, browser paths, or machine-specific Node/npm paths.

## Verification

Tests use a temporary `PI_CODING_AGENT_DIR` and fixture package checkout. They cover clean installation, repeated installation, managed updates, repair, forced managed updates, preservation of unrelated settings, precise uninstall, legacy migration, and conflict handling. A real private-package install additionally requires GitHub SSH access and a fresh Pi process or `/reload`.
