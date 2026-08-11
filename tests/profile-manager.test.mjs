import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyProfile,
  prepareProfile,
  readJson,
  uninstallProfile,
  validateProfile,
  verifyProfile,
} from "../scripts/profile-manager.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const profile = readJson(join(root, "profile.json"), {});
const options = {
  npx: "C:\\Tools\\node\\npx.cmd",
  browser: "msedge",
  outputDir: "C:\\Temp\\pi-playwright-mcp",
};

function makeFixture(settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-config-test-"));
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir, { recursive: true });
  const packages = profile.packages.map((item) => item.source);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages, ...settings }, null, 2)}\n`);
  const workflow = join(agentDir, "git", "github.com", "JerryBay", "codex-workflow-profile");
  mkdirSync(workflow, { recursive: true });
  writeFileSync(join(workflow, "AGENTS.md"), "# Shared agent rules\n\nUse local evidence.\n");
  return { agentDir, directory, workflow };
}

function clean(fixture) {
  rmSync(fixture.directory, { recursive: true, force: true });
}

test("profile manifest contains valid portable resources", () => {
  const result = validateProfile(root, profile);
  assert.equal(result.profileId, "pi-agent-config");
  assert.equal(result.packages, 8);
});

test("clean apply preserves unrelated settings and is repeatable", () => {
  const fixture = makeFixture({ defaultModel: "local-model", theme: "custom-theme" });
  try {
    prepareProfile(root, fixture.agentDir, profile);
    const first = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(first.conflicts.length, 0);

    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.equal(settings.defaultModel, "local-model");
    assert.equal(settings.theme, "custom-theme");
    assert.equal(settings.packages.length, profile.packages.length);
    assert.match(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), /Shared agent rules/);

    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    assert.equal(mcp.mcpServers.playwright.command, "C:/Tools/node/npx.cmd");
    assert.equal(mcp.mcpServers.playwright.args.includes("@playwright/mcp@0.0.79"), true);
    const settingsBefore = readFileSync(join(fixture.agentDir, "settings.json"), "utf8");
    const mcpBefore = readFileSync(join(fixture.agentDir, "mcp.json"), "utf8");

    prepareProfile(root, fixture.agentDir, profile);
    const second = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(second.conflicts.length, 0);
    assert.equal(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"), settingsBefore);
    assert.equal(readFileSync(join(fixture.agentDir, "mcp.json"), "utf8"), mcpBefore);
    verifyProfile(root, fixture.agentDir, profile);
  } finally {
    clean(fixture);
  }
});

test("managed files update until the user edits them", () => {
  const fixture = makeFixture();
  try {
    prepareProfile(root, fixture.agentDir, profile);
    applyProfile(root, fixture.agentDir, profile, options);

    writeFileSync(join(fixture.workflow, "AGENTS.md"), "# Updated remote rules\n");
    prepareProfile(root, fixture.agentDir, profile);
    const updated = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(updated.updated.includes("AGENTS.md"), true);
    assert.match(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), /Updated remote rules/);

    writeFileSync(join(fixture.agentDir, "AGENTS.md"), "# Local override\n");
    writeFileSync(join(fixture.workflow, "AGENTS.md"), "# Another remote update\n");
    prepareProfile(root, fixture.agentDir, profile);
    const conflicted = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(conflicted.conflicts.includes("AGENTS.md was modified locally"), true);
    assert.equal(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), "# Local override\n");
  } finally {
    clean(fixture);
  }
});

test("pre-existing agent context and MCP server are preserved", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "AGENTS.md"), "# Existing local rules\n");
    writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({
      settings: { outputGuard: false },
      mcpServers: { playwright: { command: "custom-playwright.cmd", args: [] } },
    }, null, 2));

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.conflicts.some((entry) => entry.startsWith("AGENTS.md differs")), true);
    assert.equal(result.conflicts.some((entry) => entry.startsWith("Existing MCP server preserved")), true);
    assert.equal(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), "# Existing local rules\n");
    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    assert.equal(mcp.settings.outputGuard, false);
    assert.equal(mcp.mcpServers.playwright.command, "custom-playwright.cmd");
  } finally {
    clean(fixture);
  }
});

test("matching legacy resources migrate out of auto-discovery and restore on uninstall", () => {
  const fixture = makeFixture();
  try {
    const selfCheckout = join(fixture.agentDir, "git", "github.com", "JerryBay", "Pi-agent-config");
    const extensionSource = join(selfCheckout, "extensions", "windows-notify");
    const skillSource = join(selfCheckout, "skills", "configure-playwright-mcp-windows");
    cpSync(join(root, "extensions", "windows-notify"), extensionSource, { recursive: true });
    cpSync(join(root, "skills", "configure-playwright-mcp-windows"), skillSource, { recursive: true });

    const extensionTarget = join(fixture.agentDir, "extensions", "windows-notify");
    const skillTarget = join(fixture.agentDir, "pi-hermes-memory", "skills", "configure-playwright-mcp-windows");
    cpSync(extensionSource, extensionTarget, { recursive: true });
    cpSync(skillSource, skillTarget, { recursive: true });

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.updated.some((entry) => entry.includes("Migrated legacy resource")), true);
    assert.equal(readJson(join(fixture.agentDir, "settings.json"), {}).packages[0], profile.packages[0].source);
    assert.equal(readFileSync(join(fixture.agentDir, "profile-state", "migrated-resources", "windows-notify-local", "index.ts"), "utf8").length > 0, true);
    assert.throws(() => readFileSync(join(extensionTarget, "index.ts"), "utf8"));

    uninstallProfile(fixture.agentDir, profile);
    assert.equal(readFileSync(join(extensionTarget, "index.ts"), "utf8").length > 0, true);
    assert.equal(readFileSync(join(skillTarget, "SKILL.md"), "utf8").length > 0, true);
  } finally {
    clean(fixture);
  }
});

test("differing legacy resources are preserved and filter the packaged copy", () => {
  const fixture = makeFixture();
  try {
    const selfCheckout = join(fixture.agentDir, "git", "github.com", "JerryBay", "Pi-agent-config");
    const extensionSource = join(selfCheckout, "extensions", "windows-notify");
    cpSync(join(root, "extensions", "windows-notify"), extensionSource, { recursive: true });
    const extensionTarget = join(fixture.agentDir, "extensions", "windows-notify");
    cpSync(extensionSource, extensionTarget, { recursive: true });
    writeFileSync(join(extensionTarget, "local-change.txt"), "keep this\n");

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.conflicts.some((entry) => entry.includes("Legacy resource differs")), true);
    const installedSettings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.deepEqual(installedSettings.packages[0].extensions, []);
    assert.equal(readFileSync(join(extensionTarget, "local-change.txt"), "utf8"), "keep this\n");

    uninstallProfile(fixture.agentDir, profile);
    const restoredSettings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.equal(restoredSettings.packages[0], profile.packages[0].source);
  } finally {
    clean(fixture);
  }
});

test("an interrupted install keeps the original package ownership snapshot", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
    prepareProfile(root, fixture.agentDir, profile);

    const partiallyInstalled = profile.packages.slice(0, 2).map((item) => item.source);
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: partiallyInstalled }, null, 2)}\n`);
    prepareProfile(root, fixture.agentDir, profile);

    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: profile.packages.map((item) => item.source) }, null, 2)}\n`);
    applyProfile(root, fixture.agentDir, profile, options);
    const state = readJson(join(fixture.agentDir, "profile-state", "pi-agent-config.json"), {});
    assert.equal(Object.values(state.packages).every((record) => record.created === true), true);
  } finally {
    clean(fixture);
  }
});

test("uninstall removes packages created by the profile", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
    prepareProfile(root, fixture.agentDir, profile);
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: profile.packages.map((item) => item.source) }, null, 2)}\n`);
    applyProfile(root, fixture.agentDir, profile, options);
    uninstallProfile(fixture.agentDir, profile);
    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.deepEqual(settings.packages, []);
  } finally {
    clean(fixture);
  }
});

test("uninstall removes only created content", () => {
  const fixture = makeFixture({ defaultModel: "keep-me" });
  try {
    prepareProfile(root, fixture.agentDir, profile);
    applyProfile(root, fixture.agentDir, profile, options);
    const result = uninstallProfile(fixture.agentDir, profile);
    assert.equal(result.removed.includes("AGENTS.md"), true);
    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.equal(settings.defaultModel, "keep-me");
    assert.equal(settings.packages.length, profile.packages.length);
  } finally {
    clean(fixture);
  }
});
