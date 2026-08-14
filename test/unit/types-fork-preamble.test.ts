import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_FORK_PREAMBLE, wrapForkTask } from "../../src/shared/types.ts";

describe("wrapForkTask", () => {
	it("wraps task with default preamble", () => {
		const wrapped = wrapForkTask("analyze diff");
		assert.match(wrapped, new RegExp(`^${DEFAULT_FORK_PREAMBLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(wrapped, /\n\nTask:\nanalyze diff$/);
	});

	it("returns task unchanged when disabled", () => {
		const task = "analyze diff";
		assert.equal(wrapForkTask(task, false), task);
	});

	it("is idempotent for already wrapped tasks", () => {
		const once = wrapForkTask("analyze diff");
		const twice = wrapForkTask(once);
		assert.equal(twice, once);
	});

	it("uses a custom preamble when provided", () => {
		const wrapped = wrapForkTask("analyze diff", "You are continuing an approved plan.");
		assert.match(wrapped, /^You are continuing an approved plan\.\n\nTask:\nanalyze diff$/);
	});

	it("falls back to the default preamble when custom preamble is undefined", () => {
		const custom = wrapForkTask("analyze diff", undefined);
		const fallback = wrapForkTask("analyze diff");
		assert.equal(custom, fallback);
	});
});
