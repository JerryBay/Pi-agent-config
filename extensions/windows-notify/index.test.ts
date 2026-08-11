import assert from "node:assert/strict";
import test from "node:test";
import { describeStopReason, FocusTracker, normalizeToastText } from "./index.ts";

test("FocusTracker detects complete focus changes", () => {
	const tracker = new FocusTracker();
	tracker.observe("before\x1b[Oafter");
	assert.equal(tracker.seen, true);
	assert.equal(tracker.blurred, true);
	tracker.observe("\x1b[I");
	assert.equal(tracker.blurred, false);
});

test("FocusTracker detects sequences split across input chunks", () => {
	const tracker = new FocusTracker();
	tracker.observe("\x1b[");
	assert.equal(tracker.seen, false);
	tracker.observe("O");
	assert.equal(tracker.seen, true);
	assert.equal(tracker.blurred, true);
});

test("normalizeToastText strips control characters, folds whitespace, and truncates", () => {
	assert.equal(normalizeToastText("  hello\n\u0000world  ", 30), "hello world");
	assert.equal(normalizeToastText("123456789", 8), "12345...");
});

test("describeStopReason distinguishes terminal outcomes", () => {
	assert.equal(describeStopReason("stop"), "Ready for input");
	assert.equal(describeStopReason("error"), "Run failed");
	assert.equal(describeStopReason("aborted"), "Run stopped");
	assert.equal(describeStopReason("length"), "Response reached the output limit");
});
