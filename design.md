# Design

## Goal

Provide one repeatable Windows installer for a portable Pi Agent workflow. The installer obtains skills and extensions from their owning Git or npm package, preserves unrelated local configuration, and generates only machine-dependent values locally.

## Ownership

- `codex-workflow-profile` owns the shared `AGENTS.md` and personal engineering skills.
- `pi-agent-config` owns the Windows notification extension, Playwright setup skill, package manifest, installer, and generated configuration policy.
- Third-party repositories own their own Pi packages; this repository stores only their source links and filters.
- The target machine owns models, provider credentials, sessions, trust decisions, paths, and persistent memory data.

## Update Policy

Unversioned Git and npm package sources obtain their current upstream version when the installer runs. The Playwright MCP version remains pinned because its command-line arguments are an integration contract. The installer records resolved sources and hashes so later runs can update installer-owned, unmodified content and preserve user modifications.

## Merge Rules

- Existing scalar settings win; defaults fill missing properties only.
- Existing package entries are preserved unless an explicit legacy local source is migrated to its configured remote source.
- Package filters are applied only to entries created by this profile or entries already using the same filter.
- An existing `AGENTS.md` is adopted only when it matches the configured source; otherwise it is preserved as a conflict.
- Existing MCP servers are preserved unless the profile previously created the server and its recorded hash still matches.
- Matching legacy extension/skill directories are moved into the profile backup area to prevent duplicate auto-discovery; differing directories remain in place and disable the new package's conflicting resource type.
- Every changed user file is backed up before the first write in an install run.

## Exclusions

The profile does not manage `models.json`, provider/model defaults, presets, API keys, OAuth credentials, sessions, `trust.json`, memory databases, logs, caches, shell paths, browser paths, or Node/npm paths.

## Verification

Tests use a temporary `PI_CODING_AGENT_DIR` and fixture package checkout. They cover clean installation, repeated installation, managed updates, preservation of unrelated settings, and conflict handling. A real private-package install additionally requires GitHub SSH access and a fresh Pi process or `/reload`.
