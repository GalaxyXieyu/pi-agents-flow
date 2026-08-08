import assert from "node:assert/strict";
import test from "node:test";

import { compactText, formatClockDuration, formatDuration, sumDefinedNumbers } from "../../src/shared/formatters.ts";

test("formatDuration uses one compact human-readable convention", () => {
	assert.equal(formatDuration(250), "250ms");
	assert.equal(formatDuration(1_500), "1.5s");
	assert.equal(formatDuration(10_001), "10s");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(125_000), "2m5s");
	assert.equal(formatDuration(7_320_000), "2h2m");
	assert.equal(formatDuration(-1), "0ms");
});

test("formatClockDuration uses bounded clock fields", () => {
	assert.equal(formatClockDuration(45_000), "00:45");
	assert.equal(formatClockDuration(125_000), "02:05");
	assert.equal(formatClockDuration(7_323_000), "2:02:03");
	assert.equal(formatClockDuration(-1), "00:00");
});

test("compactText normalizes whitespace and respects small limits", () => {
	assert.equal(compactText("  alpha\n beta  ", 20), "alpha beta");
	assert.equal(compactText("abcdefgh", 6), "abc...");
	assert.equal(compactText("abcdefgh", 2), "..");
	assert.equal(compactText(undefined, 20), "");
});

test("sumDefinedNumbers preserves missing-value semantics", () => {
	assert.equal(sumDefinedNumbers([]), undefined);
	assert.equal(sumDefinedNumbers([undefined, undefined]), undefined);
	assert.equal(sumDefinedNumbers([1, undefined, 2]), 3);
	assert.equal(sumDefinedNumbers([0]), 0);
});
