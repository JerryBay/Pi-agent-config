import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RESTORE_DELAYS_MS = [2_500, 10_000, 30_000];

function getTitle(pi: ExtensionAPI, cwd: string): string {
	const project = path.basename(cwd);
	const session = pi.getSessionName();
	return session ? `π - ${session} - ${project}` : `π - ${project}`;
}

export default function (pi: ExtensionAPI) {
	let timers: Array<ReturnType<typeof setTimeout>> = [];

	const clearTimers = (): void => {
		for (const timer of timers) clearTimeout(timer);
		timers = [];
	};

	const restoreTitle = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle(getTitle(pi, ctx.cwd));
	};

	pi.on("session_start", (_event, ctx) => {
		clearTimers();
		restoreTitle(ctx);

		for (const delay of RESTORE_DELAYS_MS) {
			timers.push(setTimeout(() => restoreTitle(ctx), delay));
		}
	});

	pi.on("session_info_changed", (_event, ctx) => {
		restoreTitle(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		restoreTitle(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		restoreTitle(ctx);
	});

	pi.on("session_shutdown", () => {
		clearTimers();
	});
}
