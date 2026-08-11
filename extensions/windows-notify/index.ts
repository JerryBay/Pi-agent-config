import { execFile, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const TOAST_TIMEOUT_MS = 8_000;
const POWERSHELL_FOREGROUND_EXIT = 20;

const POWERSHELL_TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

if ($env:PI_NOTIFY_SUPPRESS_TERMINAL_FG -eq '1') {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PiNotify {
    public static class NativeMethods {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    }
}
'@

    $foregroundWindow = [PiNotify.NativeMethods]::GetForegroundWindow()
    [uint32]$foregroundProcessId = 0
    [void][PiNotify.NativeMethods]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
    $foregroundProcess = Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue
    if ($foregroundProcess -and $foregroundProcess.ProcessName -like 'WindowsTerminal*') {
        exit 20
    }
}

$appId = $env:PI_NOTIFY_APP_ID
if ([string]::IsNullOrWhiteSpace($appId)) {
    $terminalPackage = Get-AppxPackage -Name Microsoft.WindowsTerminalPreview -ErrorAction SilentlyContinue
    if (-not $terminalPackage) {
        $terminalPackage = Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue
    }
    if ($terminalPackage) {
        $terminalApplication = (Get-AppxPackageManifest $terminalPackage).Package.Applications.Application |
            Where-Object { $_.Executable -eq 'WindowsTerminal.exe' } |
            Select-Object -First 1
        if ($terminalApplication) {
            $appId = "$($terminalPackage.PackageFamilyName)!$($terminalApplication.Id)"
        }
    }
}
if ([string]::IsNullOrWhiteSpace($appId)) {
    $powershellApp = Get-StartApps |
        Where-Object { $_.Name -eq 'Windows PowerShell' } |
        Select-Object -First 1
    if ($powershellApp) {
        $appId = $powershellApp.AppID
    }
}
if ([string]::IsNullOrWhiteSpace($appId)) {
    throw 'No registered Windows notification sender was found'
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast duration="short"><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$textNodes = $xml.GetElementsByTagName('text')
[void]$textNodes.Item(0).AppendChild($xml.CreateTextNode($env:PI_NOTIFY_TITLE))
[void]$textNodes.Item(1).AppendChild($xml.CreateTextNode($env:PI_NOTIFY_BODY))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show($toast)
`;

type NotifyMode = "away" | "always";
type ToastResult =
	| { status: "shown" }
	| { status: "suppressed" }
	| { status: "failed"; error: string };

type ToastOptions = {
	title: string;
	body: string;
	suppressWhenTerminalForeground?: boolean;
};

const activeProcesses = new Set<ChildProcess>();

export class FocusTracker {
	seen = false;
	blurred = false;
	private tail = "";

	reset(): void {
		this.seen = false;
		this.blurred = false;
		this.tail = "";
	}

	observe(data: string): void {
		const combined = this.tail + data;
		for (let index = 0; index <= combined.length - FOCUS_IN.length; index += 1) {
			if (combined.startsWith(FOCUS_IN, index)) {
				this.seen = true;
				this.blurred = false;
				index += FOCUS_IN.length - 1;
			} else if (combined.startsWith(FOCUS_OUT, index)) {
				this.seen = true;
				this.blurred = true;
				index += FOCUS_OUT.length - 1;
			}
		}
		this.tail = combined.slice(-(FOCUS_IN.length - 1));
	}
}

export function normalizeToastText(value: string, maxLength: number): string {
	const normalized = value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function describeStopReason(stopReason: StopReason | undefined): string {
	switch (stopReason) {
		case "error":
			return "Run failed";
		case "aborted":
			return "Run stopped";
		case "length":
			return "Response reached the output limit";
		default:
			return "Ready for input";
	}
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(1, Math.round(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function errorCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "number" ? error.code : undefined;
}

function errorMessage(error: unknown, stderr: string): string {
	const details = stderr.trim();
	if (details) return normalizeToastText(details, 300);
	if (error instanceof Error) return normalizeToastText(error.message, 300);
	return "Unknown PowerShell error";
}

export function sendWindowsToast(options: ToastOptions): Promise<ToastResult> {
	if (process.platform !== "win32") {
		return Promise.resolve({ status: "failed", error: "Windows notifications require Windows" });
	}

	return new Promise((resolve) => {
		const child = execFile(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_TOAST_SCRIPT],
			{
				env: {
					...process.env,
					PI_NOTIFY_APP_ID: process.env.PI_NOTIFY_APP_ID ?? "",
					PI_NOTIFY_TITLE: normalizeToastText(options.title, 80),
					PI_NOTIFY_BODY: normalizeToastText(options.body, 180),
					PI_NOTIFY_SUPPRESS_TERMINAL_FG: options.suppressWhenTerminalForeground ? "1" : "0",
				},
				timeout: TOAST_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, _stdout, stderr) => {
				activeProcesses.delete(child);
				if (!error) {
					resolve({ status: "shown" });
					return;
				}
				if (errorCode(error) === POWERSHELL_FOREGROUND_EXIT) {
					resolve({ status: "suppressed" });
					return;
				}
				resolve({ status: "failed", error: errorMessage(error, stderr) });
			},
		);
		activeProcesses.add(child);
	});
}

export default function windowsNotify(pi: ExtensionAPI): void {
	const focus = new FocusTracker();
	let enabled = true;
	let mode: NotifyMode = "away";
	let runStartedAt: number | undefined;
	let runSequence = 0;
	let lastNotifiedSequence = 0;
	let lastStopReason: StopReason | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;
	let focusReportingEnabled = false;
	let sessionActive = false;
	let reportedTransportFailure = false;

	const stopFocusReporting = (): void => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (focusReportingEnabled) {
			try {
				process.stdout.write(FOCUS_DISABLE);
			} catch {}
		}
		focusReportingEnabled = false;
		focus.reset();
	};

	const startFocusReporting = (ctx: ExtensionContext): void => {
		stopFocusReporting();
		if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) return;
		try {
			process.stdout.write(FOCUS_ENABLE);
			focusReportingEnabled = true;
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
				focus.observe(data);
				return undefined;
			});
		} catch {
			stopFocusReporting();
		}
	};

	const titleFor = (ctx: ExtensionContext): string => {
		const project = basename(ctx.cwd) || "workspace";
		const session = pi.getSessionName();
		return session ? `Pi - ${project} - ${session}` : `Pi - ${project}`;
	};

	const notify = async (
		ctx: ExtensionContext,
		body: string,
		options: { force?: boolean } = {},
	): Promise<ToastResult> => {
		const result = await sendWindowsToast({
			title: titleFor(ctx),
			body,
			suppressWhenTerminalForeground:
				!options.force && mode === "away" && !focus.seen,
		});

		if (result.status === "failed" && sessionActive && !reportedTransportFailure) {
			reportedTransportFailure = true;
			ctx.ui.notify(`Windows notification failed: ${result.error}`, "warning");
		}
		return result;
	};

	pi.registerFlag("notify-disable", {
		description: "Disable Windows completion notifications",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("notify-always", {
		description: "Notify even while the Pi terminal is focused",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", (_event, ctx) => {
		sessionActive = true;
		reportedTransportFailure = false;
		enabled = !pi.getFlag("notify-disable");
		mode = pi.getFlag("notify-always") ? "always" : "away";
		startFocusReporting(ctx);
	});

	pi.on("agent_start", () => {
		if (runStartedAt === undefined) {
			runStartedAt = Date.now();
			runSequence += 1;
			lastStopReason = undefined;
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		lastStopReason = (event.message as AssistantMessage).stopReason;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const startedAt = runStartedAt;
		runStartedAt = undefined;
		if (
			ctx.mode !== "tui" ||
			!enabled ||
			startedAt === undefined ||
			lastNotifiedSequence === runSequence
		) {
			return;
		}
		lastNotifiedSequence = runSequence;

		if (mode === "away" && focus.seen && !focus.blurred) return;

		const status = describeStopReason(lastStopReason);
		const duration = formatDuration(Date.now() - startedAt);
		await notify(ctx, `${status} (${duration})`);
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		runStartedAt = undefined;
		stopFocusReporting();
		for (const child of activeProcesses) child.kill();
		activeProcesses.clear();
	});

	pi.registerCommand("notify", {
		description: "Control Windows completion notifications",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase() || "status";
			switch (command) {
				case "on":
					enabled = true;
					ctx.ui.notify(`Windows notifications enabled (${mode})`, "info");
					return;
				case "off":
					enabled = false;
					ctx.ui.notify("Windows notifications disabled for this session", "info");
					return;
				case "away":
					enabled = true;
					mode = "away";
					ctx.ui.notify("Windows notifications: away mode", "info");
					return;
				case "always":
					enabled = true;
					mode = "always";
					ctx.ui.notify("Windows notifications: always mode", "info");
					return;
				case "test": {
					const result = await notify(ctx, "Test notification", { force: true });
					if (result.status === "shown") ctx.ui.notify("Windows test notification sent", "info");
					else if (result.status === "failed") ctx.ui.notify(`Notification test failed: ${result.error}`, "error");
					return;
				}
				case "status": {
					const focusStatus = focus.seen ? (focus.blurred ? "away" : "focused") : "native fallback";
					ctx.ui.notify(
						`Windows notifications: ${enabled ? mode : "off"}; focus: ${focusStatus}`,
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify("Usage: /notify [status|test|on|off|away|always]", "warning");
			}
		},
	});
}
