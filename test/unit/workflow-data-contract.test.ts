import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertWorkflowDataContract, assertWorkflowDataFlow, selectJsonPointer } from "../../src/workflows/data-contract.ts";
import { parseWorkflowResult } from "../../src/workflows/result-contract.ts";
import type { WorkflowDataContract, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

function outputPort(mediaType = "text/plain"): NonNullable<WorkflowDataContract["outputs"]>[string] {
	return { mediaType, description: "test output", storage: "auto", required: false, classification: "internal" };
}

function plan(id: string, dependsOn: string[], dataContract: WorkflowDataContract): WorkflowWorkUnitPlan {
	return {
		id,
		taskId: "task",
		kind: "custom",
		label: id,
		order: 0,
		dependsOn,
		agentSpec: { id: `${id}-agent`, baseAgent: "worker", role: id, objective: id, instructions: id, context: "fresh" },
		dataContract,
	};
}

describe("WorkflowDataContract", () => {
	it("rejects hidden dependencies, ambiguous fan-in, and executable-looking extension names", () => {
		assert.throws(() => assertWorkflowDataContract(plan("consumer", ["producer"], {
			version: 1, profile: "generic", inputs: [{ name: "input", purpose: "hidden", from: [{ nodeId: "other", port: "data" }] }], outputs: { result: outputPort() },
		})), /not a direct dependency/);
		assert.throws(() => assertWorkflowDataContract(plan("consumer", ["producer"], {
			version: 1, profile: "generic", inputs: [{ name: "input", purpose: "fan-in", from: [{ nodeId: "producer", port: "data" }, { nodeId: "producer", port: "summary" }] }], outputs: { result: outputPort() },
		})), /merge is required/);
		assert.throws(() => assertWorkflowDataContract(plan("consumer", [], {
			version: 1, profile: "generic", inputs: [], outputs: { result: outputPort() }, extensions: { script: "run me" },
		})), /namespace\/name@version/);
	});

	it("rejects undeclared source ports and invalid delivery semantics at graph compile time", () => {
		const producer = plan("producer", [], { version: 1, profile: "generic", inputs: [], outputs: { metrics: outputPort("application/json") } });
		const consumer = plan("consumer", ["producer"], {
			version: 1, profile: "generic",
			inputs: [{ name: "input", purpose: "consume", from: [{ nodeId: "producer", port: "missing" }], merge: "first" }],
			outputs: { result: outputPort() },
		});
		assert.throws(() => assertWorkflowDataContract(plan("consumer", ["producer"], {
			version: 1, profile: "generic",
			inputs: [{ name: "input", purpose: "consume", from: [{ nodeId: "producer", port: "metrics" }], delivery: "stream" as never, merge: "first" }],
			outputs: { result: outputPort() },
		})), /delivery is invalid/);
		assert.throws(() => assertWorkflowDataFlow([producer, consumer]), /undeclared port/);
	});

	it("rejects concat-text bindings from non-text output ports at graph compile time", () => {
		const producer = plan("producer", [], { version: 1, profile: "generic", inputs: [], outputs: { findings: outputPort("application/json") } });
		const consumer = plan("consumer", ["producer"], {
			version: 1,
			profile: "generic",
			inputs: [{ name: "evidence", purpose: "combine research evidence", from: [{ nodeId: "producer", port: "findings" }], merge: "concat-text" }],
			outputs: { result: outputPort() },
		});
		assert.throws(() => assertWorkflowDataFlow([producer, consumer]), /uses concat-text.*not a text media type/);
	});

	it("rejects object value submissions for text output ports", () => {
		const dataContract: WorkflowDataContract = {
			version: 1,
			profile: "generic",
			inputs: [],
			outputs: { findings: { mediaType: "text/markdown", description: "research findings", storage: "inline", required: true, classification: "internal" } },
		};
		const submission = {
			version: 1,
			summary: { text: "summary", covers: [], omissions: [], confidence: "high" },
			outputs: { findings: { kind: "value", value: { claim: "not text" } } },
			diagnostics: { gaps: [], conflicts: [], warnings: [] },
			recommendations: [],
		};
		assert.throws(() => parseWorkflowResult(submission, dataContract), /declares text\/markdown but its value submission is not text/);
	});

	it("requires dataContract profile to match the work-unit kind", () => {
		const research = plan("research", [], { version: 1, profile: "generic", inputs: [], outputs: { result: outputPort() } });
		research.kind = "research";
		assert.throws(() => assertWorkflowDataContract(research), /must use dataContract\.profile 'research'/);
	});

	it("accepts namespaced metadata but never assigns it runtime semantics", () => {
		assert.doesNotThrow(() => assertWorkflowDataContract(plan("consumer", [], {
			version: 1, profile: "generic", inputs: [],
			outputs: { metrics: { mediaType: "application/json", description: "metrics", storage: "inline", required: true, classification: "public" } },
			annotations: { owner: "model", priority: 2 },
			extensions: { "com.example/review@1": { rubric: ["correctness"] } },
		})));
	});

	it("rejects a plan-level release gate and points to the Reviewer-result mechanism", () => {
		const base = { version: 1, profile: "generic" as const, inputs: [], outputs: { result: outputPort() } };
		// A bare `release` key is both unnamespaced and a release attempt.
		assert.throws(
			() => assertWorkflowDataContract(plan("consumer", [], { ...base, extensions: { release: { release: true, gapsAccepted: true } } })),
			/release gates are returned by the Reviewer child in its result/,
		);
		// A namespaced name whose value is release-shaped is also rejected with the same hint.
		assert.throws(
			() => assertWorkflowDataContract(plan("consumer", [], { ...base, extensions: { "pi/review@1": { release: true, conflictsAccepted: true } } })),
			/release gates are returned by the Reviewer child in its result/,
		);
	});

	it("still rejects truly unnamespaced metadata keys with the existing message", () => {
		assert.throws(
			() => assertWorkflowDataContract(plan("consumer", [], {
				version: 1, profile: "generic", inputs: [],
				outputs: { result: outputPort() },
				extensions: { note: "free-form" },
			})),
			/must use namespace\/name@version/,
		);
	});

	it("resolves escaped JSON Pointer tokens and rejects missing paths", () => {
		const value = { data: { "a/b": { "~key": ["zero", "one"] } } };
		assert.equal(selectJsonPointer(value, "/data/a~1b/~0key/1"), "one");
		assert.throws(() => selectJsonPointer(value, "/data/missing"), /did not resolve/);
	});
});
