import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import restoreTerminalTitle from "./index.ts";

test("restores the native Pi title across session events", () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	const titles: string[] = [];
	let sessionName: string | undefined = "Portable session";
	const pi = {
		on(name: string, handler: (...args: any[]) => void) {
			handlers.set(name, handler);
		},
		getSessionName() {
			return sessionName;
		},
	};
	const cwd = join(tmpdir(), "portable-project");
	const ctx = {
		mode: "tui",
		cwd,
		ui: { setTitle(title: string) { titles.push(title); } },
	};

	restoreTerminalTitle(pi as any);
	assert.deepEqual([...handlers.keys()], [
		"session_start",
		"session_info_changed",
		"agent_start",
		"agent_settled",
		"session_shutdown",
	]);

	handlers.get("session_start")?.({}, ctx);
	assert.equal(titles.at(-1), "π - Portable session - portable-project");

	sessionName = undefined;
	handlers.get("session_info_changed")?.({}, ctx);
	assert.equal(titles.at(-1), "π - portable-project");

	handlers.get("session_shutdown")?.();
});

test("does not set a title outside TUI mode", () => {
	const handlers = new Map<string, (...args: any[]) => void>();
	let calls = 0;
	const pi = {
		on(name: string, handler: (...args: any[]) => void) { handlers.set(name, handler); },
		getSessionName() { return undefined; },
	};

	restoreTerminalTitle(pi as any);
	handlers.get("agent_start")?.({}, {
		mode: "rpc",
		cwd: process.cwd(),
		ui: { setTitle() { calls += 1; } },
	});
	assert.equal(calls, 0);
});
