---
name: "configure-playwright-mcp-windows"
description: "Configure and verify Microsoft Playwright MCP in Pi on Windows without relying on broken shell shims"
version: 1
created: "2026-08-11"
updated: "2026-08-11"
---
## When to Use
Use when adding or repairing Microsoft Playwright MCP for Pi on Windows, especially when Git Bash or npm shims are unreliable.

## Procedure
1. Read the installed pi-mcp-adapter README and determine its effective global MCP config path and precedence.
2. Resolve node, npm, and npx with PowerShell Get-Command and where.exe; select a known-good absolute npx.cmd.
3. Query npm metadata for @playwright/mcp, pin a tested stable version, and verify the Node engine requirement.
4. Check for an installed Chrome or Edge channel before choosing --browser.
5. Create or merge ~/.pi/agent/mcp.json with a lazy Playwright server, isolated browser state, bounded output directory, and proxy-mode tools.
6. Reload Pi, connect the server, and confirm the tool count without extension errors.
7. Call browser_navigate, browser_snapshot, and browser_close against a harmless page to verify end-to-end browser operation.

## Pitfalls
- Do not use a damaged npm shim found earlier on PATH; resolve and test the real Windows npx.cmd path.
- A successful MCP handshake does not prove browser launch or navigation; run a real navigate/snapshot/close smoke test.
- Use isolated browser state by default so parallel sessions do not share or lock a persistent profile.
- When the active Pi model is declared text-only, omit inline image responses until backend image support is verified.
- Use forward-slash Windows paths for Node stdio commands when cross-spawn or cmd quoting strips backslashes.

## Verification
1. The MCP adapter reports the Playwright server connected and lists its tools.
2. A real browser navigation returns the expected page text in a snapshot.
3. The browser_close call succeeds and no project files are created.
4. The MCP config parses as JSON and survives a fresh Pi process.