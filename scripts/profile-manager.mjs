import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, copyFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const result = { command: argv[0] ?? "validate" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashValue(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashDirectory(path) {
  const hash = createHash("sha256");
  const visit = (directory, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".pi-agent-config-archive.json") continue;
      const absolute = join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute, childRelative);
      else {
        hash.update(childRelative.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  visit(path);
  return hash.digest("hex");
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporary = `${path}.${suffix}.tmp`;
  const previous = `${path}.${suffix}.previous`;
  writeFileSync(temporary, next, "utf8");
  if (!existsSync(path)) {
    renameSync(temporary, path);
    return true;
  }
  renameSync(path, previous);
  try {
    renameSync(temporary, path);
    rmSync(previous, { force: true });
  } catch (error) {
    if (existsSync(previous) && !existsSync(path)) renameSync(previous, path);
    rmSync(temporary, { force: true });
    throw error;
  }
  return true;
}

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function sourceEquals(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function withPackageSource(entry, source) {
  return typeof entry === "string" ? source : { ...structuredClone(entry), source };
}

function migrationEntry(record) {
  return record?.entry ?? record;
}

function findPackageIndex(packages, source) {
  return packages.findIndex((entry) => sourceEquals(packageSource(entry), source));
}

function findPackage(profile, id) {
  const item = profile.packages.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown package id: ${id}`);
  return item;
}

function gitCoordinates(item) {
  const match = item.gitUrl?.match(/^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Cannot derive Git coordinates from ${item.gitUrl}`);
  return { host: match[1], owner: match[2], repository: match[3] };
}

function checkoutPath(agentDir, item) {
  const { host, owner, repository } = gitCoordinates(item);
  return join(agentDir, "git", host, owner, repository);
}

function localPackageName(source) {
  if (typeof source !== "string" || /^(?:npm:|git:|https?:|ssh:|git@)/i.test(source)) return undefined;
  const packagePath = join(source, "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    return readJson(packagePath, {}).name;
  } catch {
    return undefined;
  }
}

function ensureState(state, profile) {
  state.schemaVersion ??= 1;
  state.profileId ??= profile.id;
  state.packages ??= {};
  state.files ??= {};
  state.mcpServers ??= {};
  state.settingsDefaults ??= {};
  state.mcpSettingsDefaults ??= {};
  state.migratedSources ??= [];
  state.legacyResources ??= {};
  return state;
}

function validateProfile(root, profile) {
  const errors = [];
  if (profile.schemaVersion !== 1) errors.push("profile.schemaVersion must be 1");
  if (!profile.id) errors.push("profile.id is required");
  if (!Array.isArray(profile.packages) || profile.packages.length === 0) errors.push("profile.packages must not be empty");

  const ids = new Set();
  const sources = new Set();
  for (const item of profile.packages ?? []) {
    if (!item.id || !item.source) errors.push("Every package requires id and source");
    if (ids.has(item.id)) errors.push(`Duplicate package id: ${item.id}`);
    if (sources.has(item.source?.toLowerCase())) errors.push(`Duplicate package source: ${item.source}`);
    if (item.archive && (!Array.isArray(item.archive.include) || item.archive.include.length === 0 || !item.archive.targetRelativePath)) {
      errors.push(`Snapshot package requires include paths and targetRelativePath: ${item.id}`);
    }
    ids.add(item.id);
    sources.add(item.source?.toLowerCase());
  }

  const scan = (value, path = "profile") => {
    if (typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value)) errors.push(`Absolute Windows path at ${path}`);
    else if (Array.isArray(value)) value.forEach((item, index) => scan(item, `${path}[${index}]`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => scan(item, `${path}.${key}`));
  };
  scan(profile);

  for (const resource of profile.legacyResources ?? []) {
    if (!ids.has(resource.packageId)) errors.push(`Unknown legacy resource package: ${resource.packageId}`);
    if (!resource.id || !["extensions", "skills"].includes(resource.resourceType)) {
      errors.push("Every legacy resource requires an id and a supported resourceType");
    }
    if (!resource.sourceRelativePath || !resource.targetRelativePath) {
      errors.push(`Legacy resource paths are required: ${resource.id ?? "unknown"}`);
    }
  }

  const packageJson = readJson(join(root, "package.json"), {});
  for (const resourceType of ["extensions", "skills", "prompts", "themes"]) {
    for (const relativePath of packageJson.pi?.[resourceType] ?? []) {
      if (!existsSync(resolve(root, relativePath))) errors.push(`Missing Pi ${resourceType} resource: ${relativePath}`);
    }
  }
  const skillPath = join(root, "skills", "configure-playwright-mcp-windows", "SKILL.md");
  if (!existsSync(skillPath) || !/^---\r?\n[\s\S]*?\r?\n---/m.test(readFileSync(skillPath, "utf8"))) {
    errors.push("Playwright skill is missing valid frontmatter");
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return { packages: profile.packages.length, profileId: profile.id };
}

function migratePackageAliases(settings, state, profile) {
  let count = 0;
  settings.packages ??= [];
  for (const item of profile.packages) {
    for (const legacySource of item.legacySources ?? []) {
      const index = findPackageIndex(settings.packages, legacySource);
      if (index < 0 || findPackageIndex(settings.packages, item.source) >= 0) continue;
      const original = structuredClone(settings.packages[index]);
      const replacement = withPackageSource(original, item.source);
      if (!state.migratedSources.some((record) => sourceEquals(packageSource(migrationEntry(record)), legacySource))) {
        state.migratedSources.push({
          entry: original,
          replacementSource: item.source,
          appliedEntryHash: hashValue(replacement),
          requireLocalPath: false,
        });
      }
      settings.packages[index] = replacement;
      count += 1;
    }
  }
  return count;
}

function prepareProfile(root, agentDir, profile) {
  const stateDir = join(agentDir, "profile-state");
  const statePath = join(stateDir, `${profile.id}.json`);
  const state = ensureState(readJson(statePath, {}), profile);
  const settingsPath = join(agentDir, "settings.json");
  const settings = readJson(settingsPath, {});
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backupDir = join(stateDir, "backups", runId);
  let backedUp = false;

  for (const name of ["settings.json", "mcp.json", "AGENTS.md"]) {
    const source = join(agentDir, name);
    if (!existsSync(source)) continue;
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(source, join(backupDir, name));
    backedUp = true;
  }

  if (!state.installInProgress || !Array.isArray(state.preInstallPackages)) {
    state.preInstallPackages = (settings.packages ?? []).map(packageSource).filter(Boolean);
  }
  const migratedAliases = migratePackageAliases(settings, state, profile);
  if (migratedAliases > 0) writeJsonAtomic(settingsPath, settings);
  state.installInProgress = true;
  state.preparedAt = new Date().toISOString();
  state.lastBackup = backedUp ? backupDir : null;
  state.profileVersion = profile.packageVersion;
  writeJsonAtomic(statePath, state);
  return { backupDir: state.lastBackup, statePath, migratedAliases };
}

function disablePackagedResource(agentDir, item, resource, disabled) {
  const resourceType = resource.resourceType;
  const manifest = readJson(join(checkoutPath(agentDir, item), "package.json"), {});
  const configured = manifest.pi?.[resourceType];
  const current = disabled[item.id]?.[resourceType] ?? configured;
  const excludedPath = resource.packageRelativePath?.replaceAll("\\", "/").toLowerCase();
  disabled[item.id] ??= {};
  disabled[item.id][resourceType] = Array.isArray(current) && excludedPath
    ? current.filter((path) => path.replaceAll("\\", "/").toLowerCase() !== excludedPath)
    : [];
}

function migrateLegacyResources(agentDir, profile, state, summary) {
  const disabled = {};
  for (const resource of profile.legacyResources ?? []) {
    const targetPath = join(agentDir, resource.targetRelativePath);
    if (!existsSync(targetPath)) continue;

    const item = findPackage(profile, resource.packageId);
    const sourcePath = join(checkoutPath(agentDir, item), resource.sourceRelativePath);
    if (!existsSync(sourcePath)) {
      summary.conflicts.push(`Legacy resource source is missing: ${resource.id}`);
      disablePackagedResource(agentDir, item, resource, disabled);
      continue;
    }

    const sourceHash = hashDirectory(sourcePath);
    const targetHash = hashDirectory(targetPath);
    if (sourceHash !== targetHash) {
      summary.conflicts.push(`Legacy resource differs and was preserved: ${resource.targetRelativePath}`);
      disablePackagedResource(agentDir, item, resource, disabled);
      continue;
    }

    const backupPath = join(agentDir, "profile-state", "migrated-resources", resource.id);
    if (existsSync(backupPath)) {
      summary.conflicts.push(`Legacy resource backup already exists: ${resource.id}`);
      disablePackagedResource(agentDir, item, resource, disabled);
      continue;
    }
    mkdirSync(dirname(backupPath), { recursive: true });
    renameSync(targetPath, backupPath);
    state.legacyResources[resource.id] = {
      originalPath: targetPath,
      backupPath,
      hash: targetHash,
    };
    summary.updated.push(`Migrated legacy resource: ${resource.targetRelativePath}`);
  }
  return disabled;
}

function applyPackagePolicy(agentDir, settings, state, profile, summary, dynamicFilters = {}, options = {}) {
  settings.packages ??= [];
  const preexisting = state.preInstallPackages ?? [];

  for (const item of profile.packages) {
    let index = findPackageIndex(settings.packages, item.source);
    if (index < 0 && item.archive && existsSync(checkoutPath(agentDir, item))) {
      settings.packages.push(item.source);
      index = settings.packages.length - 1;
      summary.added.push(`Package setting: ${item.id}`);
    }
    if (index < 0) {
      summary.conflicts.push(`Package was not installed: ${item.source}`);
      continue;
    }
    const migratedExternalSource = state.migratedSources.some((migration) =>
      migration?.requireLocalPath === false && sourceEquals(migration.replacementSource, item.source));
    state.packages[item.id] ??= {
      source: item.source,
      created: !preexisting.some((source) => sourceEquals(source, item.source)) && !migratedExternalSource,
    };
    state.packages[item.id].source = item.source;

    const desiredFilter = {
      ...(item.filter ? structuredClone(item.filter) : {}),
      ...(dynamicFilters[item.id] ?? {}),
    };
    if (Object.keys(desiredFilter).length === 0) continue;
    const current = settings.packages[index];
    const record = state.packages[item.id];
    const desiredEntry = { source: item.source, ...desiredFilter };
    const currentHash = hashValue(current);
    const desiredHash = hashValue(desiredEntry);
    const dynamicFilter = dynamicFilters[item.id];

    if (record.created) {
      if (record.appliedEntryHash && currentHash !== record.appliedEntryHash && !options.forceManagedUpdate) {
        summary.conflicts.push(`Managed package filter was modified locally: ${item.id}`);
        continue;
      }
      settings.packages[index] = desiredEntry;
      record.appliedEntryHash = desiredHash;
      summary[currentHash === desiredHash ? "already" : "updated"].push(`Package filter: ${item.id}`);
    } else if (dynamicFilter) {
      if (record.appliedEntryHash && currentHash !== record.appliedEntryHash && !options.forceManagedUpdate) {
        summary.conflicts.push(`Managed package filter was modified locally: ${item.id}`);
        continue;
      }
      record.originalEntry ??= structuredClone(current);
      settings.packages[index] = desiredEntry;
      record.appliedEntryHash = desiredHash;
      summary[currentHash === desiredHash ? "already" : "updated"].push(`Package filter: ${item.id}`);
    } else if (typeof current === "object" && Object.entries(desiredFilter).every(([key, value]) => stableJson(current[key]) === stableJson(value))) {
      summary.already.push(`Package filter: ${item.id}`);
    } else {
      summary.preserved.push(`Existing package filter: ${item.id}`);
    }
  }

  for (const item of profile.packages.filter((candidate) => candidate.legacyLocalPackageName)) {
    if (findPackageIndex(settings.packages, item.source) < 0) continue;
    const retained = [];
    for (const entry of settings.packages) {
      const source = packageSource(entry);
      if (sourceEquals(source, item.source) || localPackageName(source) !== item.legacyLocalPackageName) {
        retained.push(entry);
        continue;
      }
      if (!state.migratedSources.some((migration) => sourceEquals(packageSource(migrationEntry(migration)), source))) {
        state.migratedSources.push({
          entry: structuredClone(entry),
          replacementSource: item.source,
          requireLocalPath: true,
        });
      }
      summary.updated.push(`Migrated local package source: ${source}`);
    }
    settings.packages = retained;
  }
}

function applyDefaults(target, defaults, records, label, summary, options = {}) {
  for (const [key, value] of Object.entries(defaults ?? {})) {
    const record = records[key];
    if (!Object.hasOwn(target, key)) {
      if (record && !options.repair) {
        summary.conflicts.push(`${label}.${key} was removed locally`);
        continue;
      }
      target[key] = structuredClone(value);
      records[key] = { created: true, value: structuredClone(value) };
      summary[record ? "updated" : "added"].push(`${label}.${key}`);
      continue;
    }
    if (!record) {
      summary.preserved.push(`${label}.${key}`);
      continue;
    }
    if (stableJson(target[key]) === stableJson(value)) {
      record.value = structuredClone(value);
      summary.already.push(`${label}.${key}`);
      continue;
    }
    if (stableJson(target[key]) !== stableJson(record.value) && !options.forceManagedUpdate) {
      summary.conflicts.push(`${label}.${key} was modified locally`);
      continue;
    }
    target[key] = structuredClone(value);
    record.value = structuredClone(value);
    summary.updated.push(`${label}.${key}`);
  }
}

function applyAgentContext(agentDir, profile, state, options, summary) {
  const context = profile.agentContext;
  if (!context) return;
  const item = findPackage(profile, context.packageId);
  const sourcePath = join(checkoutPath(agentDir, item), context.relativePath);
  if (!existsSync(sourcePath)) {
    summary.conflicts.push(`Agent context source is missing: ${sourcePath}`);
    return;
  }

  const targetPath = join(agentDir, "AGENTS.md");
  const sourceHash = hashFile(sourcePath);
  const record = state.files.AGENTS;
  if (!existsSync(targetPath)) {
    if (record && !options.repair) {
      summary.conflicts.push("AGENTS.md was removed locally");
      return;
    }
    copyFileSync(sourcePath, targetPath);
    state.files.AGENTS = { created: true, hash: sourceHash, source: `${item.id}/${context.relativePath}` };
    summary[record ? "updated" : "added"].push("AGENTS.md");
    return;
  }

  const currentHash = hashFile(targetPath);
  if (!record) {
    if (currentHash === sourceHash) {
      state.files.AGENTS = { created: false, hash: currentHash, source: `${item.id}/${context.relativePath}` };
      summary.already.push("AGENTS.md adopted");
    } else {
      summary.conflicts.push("AGENTS.md differs from the remote workflow source");
    }
    return;
  }

  if (currentHash === sourceHash) {
    record.hash = sourceHash;
    summary.already.push("AGENTS.md");
    return;
  }
  if (currentHash !== record.hash) {
    if (!options.forceManagedUpdate) {
      summary.conflicts.push("AGENTS.md was modified locally");
      return;
    }
    copyFileSync(sourcePath, targetPath);
    record.hash = sourceHash;
    summary.updated.push("AGENTS.md forced to the managed source");
    return;
  }
  copyFileSync(sourcePath, targetPath);
  record.hash = sourceHash;
  summary.updated.push("AGENTS.md");
}

function makePlaywrightServer(profile, options) {
  const config = profile.mcp.playwright;
  const outputDir = options.outputDir.replaceAll("\\", "/");
  const command = options.npx.replaceAll("\\", "/");
  return {
    command,
    args: [
      "-y",
      config.package,
      "--browser",
      options.browser,
      "--isolated",
      "--image-responses",
      config.imageResponses,
      "--output-dir",
      outputDir,
      "--output-max-size",
      String(config.outputMaxSize),
      "--viewport-size",
      config.viewportSize,
    ],
    lifecycle: config.lifecycle,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

function applyMcp(agentDir, profile, state, options, summary) {
  const mcpPath = join(agentDir, "mcp.json");
  const mcp = readJson(mcpPath, {});
  mcp.settings ??= {};
  mcp.mcpServers ??= {};
  applyDefaults(mcp.settings, profile.mcp.settingsDefaults, state.mcpSettingsDefaults, "mcp.settings", summary, options);

  if (!options.npx || !options.browser || !options.outputDir) {
    summary.preserved.push("Playwright MCP skipped because npx or a supported browser was not detected");
    writeJsonAtomic(mcpPath, mcp);
    return;
  }

  const name = profile.mcp.playwright.serverName;
  const next = makePlaywrightServer(profile, options);
  const nextHash = hashValue(next);
  const current = mcp.mcpServers[name];
  const record = state.mcpServers[name];

  if (!current) {
    if (record && !options.repair) {
      summary.conflicts.push(`MCP server was removed locally: ${name}`);
    } else {
      mcp.mcpServers[name] = next;
      state.mcpServers[name] = { created: true, hash: nextHash };
      summary[record ? "updated" : "added"].push(`MCP server: ${name}`);
    }
  } else if (!record) {
    if (hashValue(current) === nextHash) {
      state.mcpServers[name] = { created: false, hash: nextHash };
      summary.already.push(`MCP server adopted: ${name}`);
    } else {
      summary.conflicts.push(`Existing MCP server preserved: ${name}`);
    }
  } else if (hashValue(current) === nextHash) {
    record.hash = nextHash;
    summary.already.push(`MCP server: ${name}`);
  } else if (hashValue(current) !== record.hash) {
    if (!options.forceManagedUpdate) {
      summary.conflicts.push(`MCP server was modified locally: ${name}`);
    } else {
      mcp.mcpServers[name] = next;
      record.hash = nextHash;
      summary.updated.push(`MCP server forced to managed configuration: ${name}`);
    }
  } else {
    mcp.mcpServers[name] = next;
    record.hash = nextHash;
    summary.updated.push(`MCP server: ${name}`);
  }
  writeJsonAtomic(mcpPath, mcp);
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "pi-agent-config" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
    }
  }
  throw new Error(`Download failed after ${attempts} attempts: ${url}: ${lastError?.message ?? lastError}`);
}

async function runWithConcurrency(items, limit, action) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await action(items[index]);
    }
  });
  await Promise.all(workers);
}

async function installArchivePackage(agentDir, profile, packageId, gitCommand = "git") {
  const item = findPackage(profile, packageId);
  if (!item.archive) throw new Error(`Package is not configured for snapshot installation: ${packageId}`);
  const targetPath = checkoutPath(agentDir, item);
  const markerPath = join(targetPath, ".pi-agent-config-archive.json");
  const remoteOutput = execFileSync(gitCommand, ["ls-remote", "--exit-code", item.gitUrl, "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  }).trim();
  const remoteCommit = remoteOutput.split(/\s+/)[0];
  let currentCommit;

  if (existsSync(markerPath)) {
    const marker = readJson(markerPath, {});
    if (hashDirectory(targetPath) !== marker.hash) return { status: "preserved", commit: marker.commit, path: targetPath };
    currentCommit = marker.commit;
  } else if (existsSync(join(targetPath, ".git"))) {
    const dirty = execFileSync(gitCommand, ["-C", targetPath, "status", "--porcelain"], {
      encoding: "utf8", windowsHide: true, timeout: 20_000,
    }).trim();
    if (dirty) return { status: "preserved", path: targetPath };
    currentCommit = execFileSync(gitCommand, ["-C", targetPath, "rev-parse", "HEAD"], {
      encoding: "utf8", windowsHide: true, timeout: 20_000,
    }).trim();
  } else if (existsSync(targetPath)) {
    return { status: "preserved", path: targetPath };
  }

  if (currentCommit === remoteCommit) return { status: "already", commit: remoteCommit, path: targetPath };

  const { owner, repository } = gitCoordinates(item);
  const treeResponse = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repository}/git/trees/${remoteCommit}?recursive=1`);
  const tree = await treeResponse.json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(`GitHub returned an incomplete tree for ${packageId}`);
  const includes = item.archive.include ?? [];
  const excludes = new Set(item.archive.exclude ?? []);
  const files = tree.tree.filter((entry) => entry.type === "blob" && !excludes.has(entry.path) && includes.some((prefix) => prefix.endsWith("/") ? entry.path.startsWith(prefix) : entry.path === prefix));
  if (files.length === 0) throw new Error(`No files selected for snapshot package: ${packageId}`);

  const workRoot = join(agentDir, "profile-state", "downloads", randomUUID());
  const stagingPath = join(workRoot, "package");
  const backupPath = `${targetPath}.pi-agent-config-backup-${randomUUID()}`;
  mkdirSync(stagingPath, { recursive: true });
  try {
    await runWithConcurrency(files, 4, async (entry) => {
      const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
      let content;
      try {
        const response = await fetchWithRetry(`https://raw.githubusercontent.com/${owner}/${repository}/${remoteCommit}/${encodedPath}`);
        content = Buffer.from(await response.arrayBuffer());
      } catch {
        const blobResponse = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repository}/git/blobs/${entry.sha}`);
        const blob = await blobResponse.json();
        if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`Unsupported GitHub blob response for ${entry.path}`);
        content = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
      }
      const destination = join(stagingPath, ...entry.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    });

    const packageManifestPath = join(stagingPath, "package.json");
    const packageManifest = readJson(packageManifestPath, {});
    packageManifest.pi = {
      extensions: (item.filter?.extensions ?? []).map((path) => `./${path}`),
      skills: structuredClone(item.archive.skills ?? []),
    };
    writeJsonAtomic(packageManifestPath, packageManifest);

    mkdirSync(dirname(targetPath), { recursive: true });
    if (existsSync(targetPath)) renameSync(targetPath, backupPath);
    try {
      renameSync(stagingPath, targetPath);
      writeJsonAtomic(markerPath, {
        source: item.source,
        commit: remoteCommit,
        hash: hashDirectory(targetPath),
      });
      rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      rmSync(targetPath, { recursive: true, force: true });
      if (existsSync(backupPath)) renameSync(backupPath, targetPath);
      throw error;
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
  return { status: currentCommit ? "updated" : "installed", commit: remoteCommit, files: files.length, path: targetPath };
}

function resolvePackageVersions(agentDir, profile, state) {
  for (const item of profile.packages) {
    const record = state.packages[item.id];
    if (!record) continue;
    if (item.source.startsWith("npm:")) {
      const packageName = item.source.slice(4).replace(/@[^/@]+$/, "");
      const path = join(agentDir, "npm", "node_modules", ...packageName.split("/"), "package.json");
      if (existsSync(path)) record.resolvedVersion = readJson(path, {}).version;
    } else if (item.gitUrl) {
      const path = checkoutPath(agentDir, item);
      const archiveMarker = join(path, ".pi-agent-config-archive.json");
      if (existsSync(archiveMarker)) {
        record.resolvedCommit = readJson(archiveMarker, {}).commit;
        continue;
      }
      if (!existsSync(join(path, ".git"))) continue;
      try {
        record.resolvedCommit = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        record.resolvedCommit = undefined;
      }
    }
  }
}

function applyProfile(root, agentDir, profile, options) {
  mkdirSync(agentDir, { recursive: true });
  const statePath = join(agentDir, "profile-state", `${profile.id}.json`);
  const state = ensureState(readJson(statePath, {}), profile);
  const settingsPath = join(agentDir, "settings.json");
  const settings = readJson(settingsPath, {});
  const summary = { added: [], already: [], updated: [], preserved: [], conflicts: [] };

  const dynamicFilters = migrateLegacyResources(agentDir, profile, state, summary);
  applyPackagePolicy(agentDir, settings, state, profile, summary, dynamicFilters, options);
  applyDefaults(settings, profile.settingsDefaults, state.settingsDefaults, "settings", summary, options);
  writeJsonAtomic(settingsPath, settings);
  applyAgentContext(agentDir, profile, state, options, summary);
  applyMcp(agentDir, profile, state, options, summary);
  resolvePackageVersions(agentDir, profile, state);

  delete state.preInstallPackages;
  state.installInProgress = false;
  state.installedAt = new Date().toISOString();
  state.profileVersion = profile.packageVersion;
  writeJsonAtomic(statePath, state);
  return summary;
}

function verifyProfile(root, agentDir, profile) {
  validateProfile(root, profile);
  const settings = readJson(join(agentDir, "settings.json"), {});
  const missingPackages = profile.packages.filter((item) => findPackageIndex(settings.packages ?? [], item.source) < 0).map((item) => item.source);
  const result = {
    missingPackages,
    agentContextPresent: existsSync(join(agentDir, "AGENTS.md")),
    mcpConfigValid: existsSync(join(agentDir, "mcp.json")),
    statePresent: existsSync(join(agentDir, "profile-state", `${profile.id}.json`)),
  };
  if (missingPackages.length) throw new Error(`Missing managed packages:\n${missingPackages.join("\n")}`);
  return result;
}

function planProfile(agentDir, profile, options) {
  const settings = readJson(join(agentDir, "settings.json"), {});
  return {
    agentDir,
    packages: profile.packages.map((item) => ({
      source: item.source,
      action: findPackageIndex(settings.packages ?? [], item.source) >= 0 ? "update" : "install",
    })),
    agentContext: profile.agentContext,
    playwright: options.npx && options.browser ? { command: options.npx, browser: options.browser } : "skipped",
    repair: Boolean(options.repair),
    forceManagedUpdate: Boolean(options.forceManagedUpdate),
  };
}

function uninstallProfile(agentDir, profile) {
  const statePath = join(agentDir, "profile-state", `${profile.id}.json`);
  const state = ensureState(readJson(statePath, {}), profile);
  const summary = { removed: [], restored: [], preserved: [] };
  const settingsPath = join(agentDir, "settings.json");
  const settings = readJson(settingsPath, {});
  settings.packages ??= [];

  for (const [id, record] of Object.entries(state.packages)) {
    const index = findPackageIndex(settings.packages, record.source);
    if (record.created) {
      if (index >= 0) {
        settings.packages.splice(index, 1);
        summary.removed.push(`Package setting: ${id}`);
      }
      continue;
    }
    if (record.originalEntry && index >= 0 && hashValue(settings.packages[index]) === record.appliedEntryHash) {
      settings.packages[index] = record.originalEntry;
      summary.restored.push(`Package filter: ${id}`);
    } else if (record.originalEntry && index >= 0) {
      summary.preserved.push(`Modified package filter: ${id}`);
    }
  }
  for (const migration of state.migratedSources ?? []) {
    const entry = migrationEntry(migration);
    const source = packageSource(entry);
    if (!source) continue;
    const requiresLocalPath = migration?.entry ? migration.requireLocalPath === true : true;
    if (requiresLocalPath && !existsSync(source)) continue;

    const replacementSource = migration?.entry ? migration.replacementSource : undefined;
    const replacementIndex = replacementSource ? findPackageIndex(settings.packages, replacementSource) : -1;
    if (replacementIndex >= 0) {
      if (migration.appliedEntryHash && hashValue(settings.packages[replacementIndex]) !== migration.appliedEntryHash) {
        summary.preserved.push(`Modified migrated package source: ${replacementSource}`);
        continue;
      }
      settings.packages[replacementIndex] = entry;
      summary.restored.push(`Package source: ${source}`);
    } else if (findPackageIndex(settings.packages, source) < 0) {
      settings.packages.push(entry);
      summary.restored.push(`Package source: ${source}`);
    }
  }
  for (const [key, record] of Object.entries(state.settingsDefaults)) {
    if (record.created && stableJson(settings[key]) === stableJson(record.value)) {
      delete settings[key];
      summary.removed.push(`settings.${key}`);
    }
  }
  writeJsonAtomic(settingsPath, settings);

  const agentRecord = state.files.AGENTS;
  const agentsPath = join(agentDir, "AGENTS.md");
  if (agentRecord?.created && existsSync(agentsPath) && hashFile(agentsPath) === agentRecord.hash) {
    rmSync(agentsPath);
    summary.removed.push("AGENTS.md");
  } else if (agentRecord) summary.preserved.push("AGENTS.md");

  const mcpPath = join(agentDir, "mcp.json");
  if (existsSync(mcpPath)) {
    const mcp = readJson(mcpPath, {});
    for (const [name, record] of Object.entries(state.mcpServers)) {
      const current = mcp.mcpServers?.[name];
      if (record.created && current && hashValue(current) === record.hash) {
        delete mcp.mcpServers[name];
        summary.removed.push(`MCP server: ${name}`);
      } else if (current) summary.preserved.push(`MCP server: ${name}`);
    }
    for (const [key, record] of Object.entries(state.mcpSettingsDefaults)) {
      if (record.created && stableJson(mcp.settings?.[key]) === stableJson(record.value)) {
        delete mcp.settings[key];
        summary.removed.push(`mcp.settings.${key}`);
      }
    }
    writeJsonAtomic(mcpPath, mcp);
  }

  for (const [id, record] of Object.entries(state.legacyResources ?? {})) {
    if (!existsSync(record.backupPath)) continue;
    if (existsSync(record.originalPath)) {
      summary.preserved.push(`Legacy resource restore blocked: ${id}`);
      continue;
    }
    mkdirSync(dirname(record.originalPath), { recursive: true });
    renameSync(record.backupPath, record.originalPath);
    summary.restored.push(`Legacy resource: ${id}`);
  }
  rmSync(statePath, { force: true });
  return summary;
}

function printSummary(summary) {
  for (const [key, entries] of Object.entries(summary)) {
    if (!Array.isArray(entries)) continue;
    console.log(`${key.padEnd(10)} ${entries.length}`);
    for (const entry of entries) console.log(`  ${entry}`);
  }
}

export {
  applyProfile,
  planProfile,
  prepareProfile,
  readJson,
  uninstallProfile,
  validateProfile,
  verifyProfile,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = resolve(args.root || DEFAULT_ROOT);
    const agentDir = resolve(args.agentDir || process.env.PI_CODING_AGENT_DIR || join(process.env.USERPROFILE || process.env.HOME, ".pi", "agent"));
    const profile = readJson(join(root, "profile.json"), {});
    const options = {
      npx: args.npx || "",
      browser: args.browser || "",
      outputDir: args.outputDir || join(process.env.LOCALAPPDATA || agentDir, "Temp", "pi-playwright-mcp"),
      repair: Boolean(args.repair || args.forceManagedUpdate),
      forceManagedUpdate: Boolean(args.forceManagedUpdate),
    };
    let result;
    switch (args.command) {
      case "install-archive": {
        if (!args.packageId) throw new Error("install-archive requires --package-id");
        result = await installArchivePackage(agentDir, profile, args.packageId, args.git || "git");
        break;
      }
      case "hash-directory": {
        if (!args.path) throw new Error("hash-directory requires --path");
        if (!existsSync(resolve(args.path))) throw new Error(`Directory does not exist: ${args.path}`);
        result = { hash: hashDirectory(resolve(args.path)) };
        break;
      }
      case "validate": result = validateProfile(root, profile); break;
      case "prepare": result = prepareProfile(root, agentDir, profile); break;
      case "plan": result = planProfile(agentDir, profile, options); break;
      case "apply": result = applyProfile(root, agentDir, profile, options); break;
      case "verify": result = verifyProfile(root, agentDir, profile); break;
      case "uninstall": result = uninstallProfile(agentDir, profile); break;
      default: throw new Error(`Unknown command: ${args.command}`);
    }
    if (["apply", "uninstall"].includes(args.command)) printSummary(result);
    else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
