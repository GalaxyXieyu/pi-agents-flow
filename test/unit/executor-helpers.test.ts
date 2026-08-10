import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
	collectRequestedAgentNames,
	duplicateNames,
	escapeRegExp,
	firstChainAgent,
	firstRawChainTask,
	getRequestedModeLabel,
	isAsyncRunNotFound,
	isExactResumeError,
	isResumeAmbiguity,
	pathWithin,
	resolveAsyncEventGoal,
	resolveRequestedCwd,
	resumeTargetExact,
} from "../../src/runs/foreground/executor-helpers.ts";
import { DEFAULT_FORK_PREAMBLE } from "../../src/shared/types.ts";

describe("executor helpers", () => {
	it("resolves requested cwd against the runtime cwd", () => {
		assert.equal(resolveRequestedCwd("/repo", undefined), "/repo");
		assert.equal(resolveRequestedCwd("/repo", "nested"), path.resolve("/repo", "nested"));
		assert.equal(resolveRequestedCwd("/repo", "/abs"), path.resolve("/abs"));
	});

	it("classifies async resume errors and exact run-id matches", () => {
		assert.equal(isAsyncRunNotFound(new Error("Async run not found.")), true);
		assert.equal(isAsyncRunNotFound(new Error("other")), false);
		assert.equal(isResumeAmbiguity(new Error("Ambiguous async run id prefix 'ab'")), true);
		assert.equal(resumeTargetExact({ runId: "abc123" }, "abc123"), true);
		assert.equal(resumeTargetExact({ runId: "abc123" }, "abc"), false);
		assert.equal(isExactResumeError(new Error("async run 'run-1' is not resumable"), "async", "run-1"), true);
		assert.equal(isExactResumeError(new Error("async run 'run-2' is not resumable"), "async", "run-1"), false);
		assert.equal(escapeRegExp("a.b+c"), "a\\.b\\+c");
	});

	it("finds duplicate names without mutating order of first occurrence set", () => {
		assert.deepEqual(duplicateNames(["a", "b", "a", "c", "b"]), ["a", "b"]);
		assert.deepEqual(duplicateNames(["solo"]), []);
	});

	it("checks path containment with resolved absolute bases", () => {
		const base = path.resolve("/tmp/sessions");
		assert.equal(pathWithin(base, path.join(base, "child.jsonl")), true);
		assert.equal(pathWithin(base, base), true);
		assert.equal(pathWithin(base, path.resolve("/tmp/other/child.jsonl")), false);
	});

	it("labels requested modes from params shape", () => {
		assert.equal(getRequestedModeLabel({ agent: "worker" }), "single");
		assert.equal(getRequestedModeLabel({ tasks: [{ agent: "worker", task: "t" }] }), "parallel");
		assert.equal(getRequestedModeLabel({ chain: [{ agent: "worker", task: "t" }] }), "chain");
		assert.equal(getRequestedModeLabel({}), "single");
	});

	it("collects requested agent names across single/parallel/chain shapes", () => {
		assert.deepEqual(collectRequestedAgentNames({ agent: "worker" }), ["worker"]);
		assert.deepEqual(
			collectRequestedAgentNames({
				tasks: [
					{ agent: "scout", task: "a" },
					{ agent: "worker", task: "b" },
				],
			}),
			["scout", "worker"],
		);
		assert.deepEqual(
			collectRequestedAgentNames({
				chain: [
					{ agent: "planner", task: "plan" },
					{ parallel: [{ agent: "worker", task: "do" }, { agent: "reviewer", task: "check" }] },
				],
			}),
			["planner", "worker", "reviewer"],
		);
	});

	it("reads first chain agent/task and async event goals", () => {
		const chain = [
			{ agent: "planner", task: "plan it" },
			{ agent: "worker", task: "build it" },
		];
		assert.equal(firstChainAgent(chain), "planner");
		assert.equal(firstRawChainTask(chain), "plan it");
		assert.equal(resolveAsyncEventGoal("workflow task", chain), "workflow task");
		assert.equal(resolveAsyncEventGoal(undefined, chain), "plan it");
		const forked = [{ agent: "worker", task: `${DEFAULT_FORK_PREAMBLE}\n\nTask:\nreal task` }];
		assert.equal(resolveAsyncEventGoal(undefined, forked, true), "real task");
		assert.equal(resolveAsyncEventGoal(undefined, forked, false), forked[0]!.task);
	});
});
