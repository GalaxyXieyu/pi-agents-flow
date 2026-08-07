import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePiLaunchToolPlan } from "../../src/runs/shared/pi-args.ts";
import { parseSubagentDelegationRequest } from "../../src/slash/delegation-request.ts";
import { parseWorkflowActionParams } from "../../src/workflows/tool.ts";
import { parseSubagentCapabilityCeiling } from "../../src/runs/shared/capability-ceiling.ts";

function ceiling(allowedTools: string[]) {
	return parseSubagentCapabilityCeiling({ version: 1, allowedTools, denyExtensions: false, sources: ["test"] });
}

function node(agentSpec: Record<string, unknown>) {
	return {
		action: "apply_plan",
		tasks: [{ id: "task-main", label: "Main", order: 0 }],
		workUnits: [{
			id: "n1",
			taskId: "task-main",
			kind: "custom",
			label: "Node",
			order: 0,
			dependsOn: [],
			agentSpec: {
				id: "spec",
				baseAgent: "worker",
				role: "Engineer",
				objective: "Do it",
				instructions: "Follow the plan",
				context: "fresh",
					...agentSpec,
			},
			dataContract: {
				version: 1,
				profile: "generic",
				inputs: [],
				outputs: {
					result: {
						mediaType: "text/plain",
						description: "Test result",
						storage: "artifact",
						required: true,
						classification: "internal",
					},
				},
			},
		}],
	};
}

function v2Request(extra: Record<string, unknown>) {
	return {
		version: 2,
		requestId: "req-1",
		ownerRunId: "run-1",
		nodeId: "n1",
		agent: "worker",
		task: "do it",
		context: "fresh",
		cwd: "/tmp",
		result: { kind: "text" },
		...extra,
	};
}

describe("node-level tool grants and revocations", () => {
	describe("resolution semantics", () => {
		it("grants a builtin tool the base Agent does not declare", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read"], extraTools: ["write"] });
			assert.deepEqual(plan.effectiveToolAllowlist, ["read", "write"]);
			assert.deepEqual(plan.grantedTools, ["write"]);
			assert.deepEqual(plan.revokedTools, []);
		});

		it("revokes a builtin tool the base Agent does declare", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read", "write", "bash"], denyTools: ["bash"] });
			assert.deepEqual(plan.effectiveToolAllowlist, ["read", "write"]);
			assert.deepEqual(plan.revokedTools, ["bash"]);
			assert.deepEqual(plan.grantedTools, []);
		});

		it("lets denyTools win over extraTools for the same name", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read"], extraTools: ["bash"], denyTools: ["bash"] });
			assert.equal(plan.effectiveToolAllowlist.includes("bash"), false);
			assert.deepEqual(plan.grantedTools, []);
		});

		it("keeps the capability ceiling a hard cap that a grant cannot widen", () => {
			const plan = resolvePiLaunchToolPlan({
				tools: ["read"],
				extraTools: ["bash", "write"],
				capabilityCeiling: ceiling(["read", "write"]),
			});
			assert.deepEqual(plan.effectiveToolAllowlist, ["read", "write"]);
			assert.equal(plan.effectiveToolAllowlist.includes("bash"), false);
			assert.deepEqual(plan.grantedTools, ["write"]);
			assert.deepEqual(plan.capabilityAudit?.removedTools, ["bash"]);
		});

		it("still revokes below the ceiling", () => {
			const plan = resolvePiLaunchToolPlan({
				tools: ["read", "write"],
				denyTools: ["write"],
				capabilityCeiling: ceiling(["read", "write"]),
			});
			assert.deepEqual(plan.effectiveToolAllowlist, ["read"]);
			assert.deepEqual(plan.revokedTools, ["write"]);
		});

		it("drops subagent fanout authorization when it is revoked", () => {
			assert.equal(resolvePiLaunchToolPlan({ tools: ["read", "subagent"] }).fanoutAuthorized, true);
			assert.equal(resolvePiLaunchToolPlan({ tools: ["read", "subagent"], denyTools: ["subagent"] }).fanoutAuthorized, false);
		});

		it("refuses to layer grants on an Agent without an explicit allowlist", () => {
			assert.throws(() => resolvePiLaunchToolPlan({ extraTools: ["bash"] }), /explicit tools allowlist/);
			assert.throws(() => resolvePiLaunchToolPlan({ denyTools: ["bash"] }), /explicit tools allowlist/);
		});

		it("leaves an unrestricted Agent untouched when no grants are supplied", () => {
			const plan = resolvePiLaunchToolPlan({});
			assert.deepEqual(plan.effectiveToolAllowlist, []);
			assert.equal(plan.explicitToolAllowlist, false);
			assert.deepEqual(plan.grantedTools, []);
			assert.deepEqual(plan.revokedTools, []);
		});

		it("does not disturb toolBudget.block, which is a separate mechanism", () => {
			const plan = resolvePiLaunchToolPlan({ tools: ["read", "grep"], denyTools: ["grep"] });
			assert.deepEqual(plan.effectiveToolAllowlist, ["read"]);
			assert.equal("block" in plan, false);
		});
	});

	describe("workflow tool validation", () => {
		it("accepts and normalizes both fields", () => {
			const parsed = parseWorkflowActionParams(node({ extraTools: ["write", "db/query"], denyTools: ["bash"] }));
			assert.equal(parsed.action, "apply_plan");
			if (parsed.action !== "apply_plan") return;
			assert.deepEqual(parsed.workUnits[0]?.agentSpec.extraTools, ["write", "db/query"]);
			assert.deepEqual(parsed.workUnits[0]?.agentSpec.denyTools, ["bash"]);
		});

		it("omits the fields when absent", () => {
			const parsed = parseWorkflowActionParams(node({}));
			if (parsed.action !== "apply_plan") return;
			assert.equal(Object.hasOwn(parsed.workUnits[0]!.agentSpec, "extraTools"), false);
			assert.equal(Object.hasOwn(parsed.workUnits[0]!.agentSpec, "denyTools"), false);
		});

		it("rejects extension paths in extraTools", () => {
			assert.throws(() => parseWorkflowActionParams(node({ extraTools: ["./evil.ts"] })), /extension path/);
			assert.throws(() => parseWorkflowActionParams(node({ extraTools: ["a/b.js"] })), /extension path/);
		});

		it("rejects malformed and oversized lists", () => {
			assert.throws(() => parseWorkflowActionParams(node({ extraTools: [] })), /non-empty string array/);
			assert.throws(() => parseWorkflowActionParams(node({ denyTools: ["ok", ""] })), /non-empty string array/);
			assert.throws(() => parseWorkflowActionParams(node({ extraTools: "write" })), /non-empty string array/);
			assert.throws(() => parseWorkflowActionParams(node({ denyTools: Array.from({ length: 65 }, (_, i) => `t${i}`) })), /at most 64 entries/);
		});
	});

	describe("delegation v2 transport", () => {
		it("accepts the fields through the receiver whitelist", () => {
			const parsed = parseSubagentDelegationRequest(v2Request({ extraTools: ["write", "db/query"], denyTools: ["bash"] }));
			assert.equal(parsed.ok, true);
		});

		it("would have rejected them before the whitelist was extended", () => {
			const parsed = parseSubagentDelegationRequest(v2Request({ notAField: ["x"] }));
			assert.equal(parsed.ok, false);
			if (parsed.ok === false) assert.match(parsed.error ?? "", /Unsupported delegation field: notAField/);
		});

		it("enforces shape, entry count, and aggregate size", () => {
			const cases: Array<[Record<string, unknown>, RegExp]> = [
				[{ extraTools: [] }, /non-empty string array/],
				[{ extraTools: ["ok", 3] }, /non-empty string array/],
				[{ denyTools: Array.from({ length: 65 }, (_, i) => `t${i}`) }, /at most 64 entries/],
				[{ extraTools: [`${"a".repeat(1025)}`] }, /exceeds 1 KiB/],
				[{ extraTools: Array.from({ length: 32 }, (_, i) => `${i}${"a".repeat(600)}`) }, /exceed 16 KiB in aggregate/],
				[{ extraTools: ["payload.ts"] }, /must not be extension paths/],
			];
			for (const [extra, pattern] of cases) {
				const parsed = parseSubagentDelegationRequest(v2Request(extra));
				assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(extra).slice(0, 60)}`);
				if (parsed.ok === false) assert.match(parsed.error ?? "", pattern);
			}
		});
	});
});
