import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureBlender,
  applyProfile,
  decideGlobalNpmTool,
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
  repair: false,
  forceManagedUpdate: false,
};

function makeFixture(settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-config-test-"));
  const agentDir = join(directory, "agent");
  mkdirSync(agentDir, { recursive: true });
  const packages = profile.packages.map((item) => item.source);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages, ...settings }, null, 2)}\n`);
  const self = join(agentDir, "git", "github.com", "JerryBay", "Pi-agent-config");
  mkdirSync(self, { recursive: true });
  cpSync(join(root, "keybindings.json"), join(self, "keybindings.json"));
  cpSync(join(root, "package.json"), join(self, "package.json"));
  const workflow = join(agentDir, "git", "github.com", "JerryBay", "codex-workflow-profile");
  mkdirSync(workflow, { recursive: true });
  writeFileSync(join(workflow, "AGENTS.md"), "# Shared agent rules\n\nUse local evidence.\n");
  return { agentDir, directory, self, workflow };
}

function clean(fixture) {
  rmSync(fixture.directory, { recursive: true, force: true });
}

test("profile manifest contains valid portable resources", () => {
  const result = validateProfile(root, profile);
  assert.equal(result.profileId, "pi-agent-config");
  assert.equal(result.packages, 6);
  assert.deepEqual(profile.packages.map((item) => item.id), [
    "pi-agent-config",
    "codex-workflow-profile",
    "pi-mcp-adapter",
    "pi-web-access",
    "pi-subagents",
    "pi-hermes-memory",
  ]);

  const packageManifest = readJson(join(root, "package.json"), {});
  assert.equal(packageManifest.version, "0.3.0");
  assert.equal(profile.packageVersion, packageManifest.version);
  assert.deepEqual(packageManifest.pi.extensions, [
    "./extensions/windows-notify/index.ts",
    "./extensions/preset/index.ts",
    "./extensions/restore-terminal-title/index.ts",
  ]);
  assert.deepEqual(readJson(join(root, "keybindings.json"), {}), {
    "app.message.followUp": ["enter"],
    "tui.input.submit": ["ctrl+enter"],
  });
  const presetDefaults = readJson(join(root, "presets.json"), {});
  assert.deepEqual(Object.keys(presetDefaults), ["quick", "deep", "review", "research", "minimal"]);
  assert.equal(Object.values(presetDefaults).every((preset) => preset.provider === "OpenAI" && preset.model === "gpt-5.6-sol"), true);

  assert.deepEqual(profile.globalNpmTools, [{
    id: "pi-web",
    package: "@agegr/pi-web",
    version: "0.8.9",
    minimumNodeVersion: "22.19.0",
  }]);
});

test("Blender configuration preserves existing servers and uninstalls only owned entries", () => {
  const fixture = makeFixture();
  try {
    const path = join(fixture.agentDir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { playwright: { command: "keep" } }, settings: { outputGuard: true } }));
    assert.equal(configureBlender(fixture.agentDir, profile, "C:\\Tools\\python.exe", "C:\\Blender\\blender.exe").status, "created");
    const config = readJson(path, {});
    assert.equal(config.mcpServers.playwright.command, "keep");
    assert.equal(config.mcpServers.blender.env.BLENDER_MCP_HOST, "127.0.0.1");
    assert.deepEqual(config.mcpServers.blender.approveTools, ["execute_blender_code*"]);
    assert.equal(config.mcpServers.blender.command, "C:/Tools/python.exe");
    const before = readFileSync(path, "utf8");
    assert.equal(configureBlender(fixture.agentDir, profile, "different", "different").status, "preserved");
    assert.equal(readFileSync(path, "utf8"), before);
    uninstallProfile(fixture.agentDir, profile);
    assert.equal(readJson(path, {}).mcpServers.blender, undefined);
    assert.equal(readJson(path, {}).mcpServers.playwright.command, "keep");
    writeFileSync(path, JSON.stringify(config));
    assert.equal(configureBlender(fixture.agentDir, profile, "different", "different").status, "preserved");
    uninstallProfile(fixture.agentDir, profile);
    assert.deepEqual(readJson(path, {}).mcpServers.blender, config.mcpServers.blender);
  } finally { clean(fixture); }
});

test("global npm tool planning preserves ownership boundaries", () => {
  const tool = profile.globalNpmTools[0];
  assert.deepEqual(decideGlobalNpmTool(tool, "", undefined), {
    action: "install", created: true, reason: "missing",
  });
  assert.deepEqual(decideGlobalNpmTool(tool, "0.8.9", undefined), {
    action: "adopt", created: false, reason: "matching pre-existing version",
  });
  assert.equal(decideGlobalNpmTool(tool, "0.8.8", undefined).action, "conflict");

  const createdRecord = { created: true, appliedVersion: "0.8.8" };
  assert.deepEqual(decideGlobalNpmTool(tool, "0.8.8", createdRecord), {
    action: "install", created: true, reason: "updating managed version",
  });
  assert.equal(decideGlobalNpmTool(tool, "0.9.0", createdRecord).action, "conflict");
  assert.equal(decideGlobalNpmTool(tool, "0.9.0", createdRecord, { forceManagedUpdate: true }).action, "install");
  assert.equal(decideGlobalNpmTool(tool, "", createdRecord).action, "conflict");
  assert.deepEqual(decideGlobalNpmTool(tool, "", { created: false, appliedVersion: "0.8.9" }, { repair: true }), {
    action: "install", created: true, reason: "repairing removed tool",
  });
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
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), readJson(join(root, "keybindings.json"), {}));

    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    assert.equal(mcp.mcpServers.playwright.command, "C:/Tools/node/npx.cmd");
    assert.equal(mcp.mcpServers.playwright.args.includes("@playwright/mcp@0.0.79"), true);
    const settingsBefore = readFileSync(join(fixture.agentDir, "settings.json"), "utf8");
    const keybindingsBefore = readFileSync(join(fixture.agentDir, "keybindings.json"), "utf8");
    const mcpBefore = readFileSync(join(fixture.agentDir, "mcp.json"), "utf8");

    prepareProfile(root, fixture.agentDir, profile);
    const second = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(second.conflicts.length, 0);
    assert.equal(readFileSync(join(fixture.agentDir, "settings.json"), "utf8"), settingsBefore);
    assert.equal(readFileSync(join(fixture.agentDir, "keybindings.json"), "utf8"), keybindingsBefore);
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
    writeFileSync(join(fixture.self, "keybindings.json"), `${JSON.stringify({ "tui.input.submit": ["ctrl+enter", "ctrl+s"] }, null, 2)}\n`);
    prepareProfile(root, fixture.agentDir, profile);
    const updated = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(updated.updated.includes("AGENTS.md"), true);
    assert.equal(updated.updated.includes("keybindings.json"), true);
    assert.match(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), /Updated remote rules/);
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), { "tui.input.submit": ["ctrl+enter", "ctrl+s"] });

    writeFileSync(join(fixture.agentDir, "AGENTS.md"), "# Local override\n");
    writeFileSync(join(fixture.workflow, "AGENTS.md"), "# Another remote update\n");
    writeFileSync(join(fixture.agentDir, "keybindings.json"), "{\"local\":true}\n");
    writeFileSync(join(fixture.self, "keybindings.json"), "{\"managed\":true}\n");
    prepareProfile(root, fixture.agentDir, profile);
    const conflicted = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(conflicted.conflicts.includes("AGENTS.md was modified locally"), true);
    assert.equal(conflicted.conflicts.includes("keybindings.json was modified locally"), true);
    assert.equal(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), "# Local override\n");
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), { local: true });
  } finally {
    clean(fixture);
  }
});

test("repair recreates missing managed content but a normal apply preserves removals", () => {
  const fixture = makeFixture();
  try {
    prepareProfile(root, fixture.agentDir, profile);
    applyProfile(root, fixture.agentDir, profile, options);

    rmSync(join(fixture.agentDir, "AGENTS.md"));
    rmSync(join(fixture.agentDir, "keybindings.json"));
    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    delete settings.theme;
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    delete mcp.mcpServers.playwright;
    writeFileSync(join(fixture.agentDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);

    prepareProfile(root, fixture.agentDir, profile);
    const preserved = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(preserved.conflicts.includes("AGENTS.md was removed locally"), true);
    assert.equal(preserved.conflicts.includes("keybindings.json was removed locally"), true);
    assert.equal(preserved.conflicts.includes("settings.theme was removed locally"), true);
    assert.equal(preserved.conflicts.includes("MCP server was removed locally: playwright"), true);

    prepareProfile(root, fixture.agentDir, profile);
    const repaired = applyProfile(root, fixture.agentDir, profile, { ...options, repair: true });
    assert.equal(repaired.conflicts.length, 0);
    assert.match(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), /Shared agent rules/);
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), readJson(join(root, "keybindings.json"), {}));
    assert.equal(readJson(join(fixture.agentDir, "settings.json"), {}).theme, profile.settingsDefaults.theme);
    assert.equal(readJson(join(fixture.agentDir, "mcp.json"), {}).mcpServers.playwright.command, "C:/Tools/node/npx.cmd");
  } finally {
    clean(fixture);
  }
});

test("force managed update replaces modified owned content only", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: [] }, null, 2)}\n`);
    prepareProfile(root, fixture.agentDir, profile);
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify({ packages: profile.packages.map((item) => item.source) }, null, 2)}\n`);
    applyProfile(root, fixture.agentDir, profile, options);

    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    settings.theme = "local-theme";
    writeFileSync(join(fixture.agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    writeFileSync(join(fixture.agentDir, "AGENTS.md"), "# Local override\n");
    writeFileSync(join(fixture.agentDir, "keybindings.json"), "{\"local\":true}\n");
    writeFileSync(join(fixture.self, "keybindings.json"), "{\"managed\":true}\n");
    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    mcp.mcpServers.playwright.command = "local-playwright.cmd";
    writeFileSync(join(fixture.agentDir, "mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`);

    prepareProfile(root, fixture.agentDir, profile);
    const preserved = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(preserved.conflicts.includes("AGENTS.md was modified locally"), true);
    assert.equal(preserved.conflicts.includes("keybindings.json was modified locally"), true);
    assert.equal(preserved.conflicts.includes("settings.theme was modified locally"), true);
    assert.equal(preserved.conflicts.includes("MCP server was modified locally: playwright"), true);

    prepareProfile(root, fixture.agentDir, profile);
    const forced = applyProfile(root, fixture.agentDir, profile, { ...options, repair: true, forceManagedUpdate: true });
    assert.equal(forced.conflicts.length, 0);
    const forcedSettings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.equal(forcedSettings.theme, profile.settingsDefaults.theme);
    assert.match(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), /Shared agent rules/);
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), { managed: true });
    assert.equal(readJson(join(fixture.agentDir, "mcp.json"), {}).mcpServers.playwright.command, "C:/Tools/node/npx.cmd");
  } finally {
    clean(fixture);
  }
});

test("pre-existing agent context and MCP server are preserved", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.agentDir, "AGENTS.md"), "# Existing local rules\n");
    writeFileSync(join(fixture.agentDir, "keybindings.json"), "{\"existing\":true}\n");
    writeFileSync(join(fixture.agentDir, "mcp.json"), JSON.stringify({
      settings: { outputGuard: false },
      mcpServers: { playwright: { command: "custom-playwright.cmd", args: [] } },
    }, null, 2));

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.conflicts.some((entry) => entry.startsWith("AGENTS.md differs")), true);
    assert.equal(result.conflicts.some((entry) => entry.startsWith("keybindings.json differs")), true);
    assert.equal(result.conflicts.some((entry) => entry.startsWith("Existing MCP server preserved")), true);
    assert.equal(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), "# Existing local rules\n");
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), { existing: true });
    const mcp = readJson(join(fixture.agentDir, "mcp.json"), {});
    assert.equal(mcp.settings.outputGuard, false);
    assert.equal(mcp.mcpServers.playwright.command, "custom-playwright.cmd");

    prepareProfile(root, fixture.agentDir, profile);
    const forced = applyProfile(root, fixture.agentDir, profile, { ...options, repair: true, forceManagedUpdate: true });
    assert.equal(forced.conflicts.some((entry) => entry.startsWith("AGENTS.md differs")), true);
    assert.equal(forced.conflicts.some((entry) => entry.startsWith("keybindings.json differs")), true);
    assert.equal(forced.conflicts.some((entry) => entry.startsWith("Existing MCP server preserved")), true);
    assert.equal(readFileSync(join(fixture.agentDir, "AGENTS.md"), "utf8"), "# Existing local rules\n");
    assert.deepEqual(readJson(join(fixture.agentDir, "keybindings.json"), {}), { existing: true });
    assert.equal(readJson(join(fixture.agentDir, "mcp.json"), {}).mcpServers.playwright.command, "custom-playwright.cmd");
  } finally {
    clean(fixture);
  }
});

test("matching legacy resources migrate out of auto-discovery and restore on uninstall", () => {
  const fixture = makeFixture();
  try {
    const selfCheckout = join(fixture.agentDir, "git", "github.com", "JerryBay", "Pi-agent-config");
    const extensionSource = join(selfCheckout, "extensions", "windows-notify");
    const presetSource = join(selfCheckout, "extensions", "preset");
    const titleSource = join(selfCheckout, "extensions", "restore-terminal-title", "index.ts");
    const skillSource = join(selfCheckout, "skills", "configure-playwright-mcp-windows");
    cpSync(join(root, "extensions", "windows-notify"), extensionSource, { recursive: true });
    cpSync(join(root, "extensions", "preset"), presetSource, { recursive: true });
    cpSync(join(root, "extensions", "restore-terminal-title"), join(selfCheckout, "extensions", "restore-terminal-title"), { recursive: true });
    cpSync(join(root, "skills", "configure-playwright-mcp-windows"), skillSource, { recursive: true });
    cpSync(join(root, "package.json"), join(selfCheckout, "package.json"));

    const extensionTarget = join(fixture.agentDir, "extensions", "windows-notify");
    const presetTarget = join(fixture.agentDir, "extensions", "preset");
    const titleTarget = join(fixture.agentDir, "extensions", "restore-terminal-title.ts");
    const skillTarget = join(fixture.agentDir, "pi-hermes-memory", "skills", "configure-playwright-mcp-windows");
    cpSync(extensionSource, extensionTarget, { recursive: true });
    cpSync(presetSource, presetTarget, { recursive: true });
    cpSync(titleSource, titleTarget);
    writeFileSync(titleSource, readFileSync(titleSource, "utf8").replace(/\r?\n/g, "\r\n"));
    assert.notEqual(readFileSync(titleSource, "utf8"), readFileSync(titleTarget, "utf8"));
    cpSync(skillSource, skillTarget, { recursive: true });

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.updated.some((entry) => entry.includes("Migrated legacy resource")), true);
    assert.equal(readJson(join(fixture.agentDir, "settings.json"), {}).packages[0], profile.packages[0].source);
    assert.equal(readFileSync(join(fixture.agentDir, "profile-state", "migrated-resources", "windows-notify-local", "index.ts"), "utf8").length > 0, true);
    assert.equal(readFileSync(join(fixture.agentDir, "profile-state", "migrated-resources", "preset-local", "index.ts"), "utf8").length > 0, true);
    assert.equal(readFileSync(join(fixture.agentDir, "profile-state", "migrated-resources", "restore-terminal-title-local"), "utf8").length > 0, true);
    assert.throws(() => readFileSync(join(extensionTarget, "index.ts"), "utf8"));
    assert.throws(() => readFileSync(join(presetTarget, "index.ts"), "utf8"));
    assert.throws(() => readFileSync(titleTarget, "utf8"));

    uninstallProfile(fixture.agentDir, profile);
    assert.equal(readFileSync(join(extensionTarget, "index.ts"), "utf8").length > 0, true);
    assert.equal(readFileSync(join(presetTarget, "index.ts"), "utf8").length > 0, true);
    assert.equal(readFileSync(titleTarget, "utf8").length > 0, true);
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
    cpSync(join(root, "package.json"), join(selfCheckout, "package.json"));
    const extensionTarget = join(fixture.agentDir, "extensions", "windows-notify");
    cpSync(extensionSource, extensionTarget, { recursive: true });
    writeFileSync(join(extensionTarget, "local-change.txt"), "keep this\n");

    prepareProfile(root, fixture.agentDir, profile);
    const result = applyProfile(root, fixture.agentDir, profile, options);
    assert.equal(result.conflicts.some((entry) => entry.includes("Legacy resource differs")), true);
    const installedSettings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.deepEqual(installedSettings.packages[0].extensions, [
      "./extensions/preset/index.ts",
      "./extensions/restore-terminal-title/index.ts",
    ]);
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
    assert.equal(result.removed.includes("keybindings.json"), true);
    const settings = readJson(join(fixture.agentDir, "settings.json"), {});
    assert.equal(settings.defaultModel, "keep-me");
    assert.equal(settings.packages.length, profile.packages.length);
  } finally {
    clean(fixture);
  }
});
