import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reduceWorkflowEvent, reduceWorkflowEvents } from "../../src/workflows/reducer.ts";
import type { DocumentOutline, EphemeralAgentSpec, WorkflowEvent, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

function agentSpec(id: string, baseAgent: string): EphemeralAgentSpec {
	return {
		id,
		baseAgent,
		role: baseAgent,
		objective: `Run ${baseAgent}`,
		instructions: `Complete the ${baseAgent} node and return structured evidence.`,
		context: "fresh",

	};
}


function researchContract(): import("../../src/workflows/types.ts").WorkflowDataContract {
	return { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "full result", storage: "artifact", required: true, classification: "internal" } } };
}

function writerContract(): import("../../src/workflows/types.ts").WorkflowDataContract {
	return { version: 1, profile: "writer", inputs: [], outputs: { document: { mediaType: "text/markdown", description: "document", storage: "artifact", required: true, classification: "internal" } } };
}

function sectionWriterContract(): import("../../src/workflows/types.ts").WorkflowDataContract {
	return { version: 1, profile: "writer", inputs: [], outputs: { document: { mediaType: "text/markdown", description: "section draft", storage: "artifact", required: true, classification: "internal" } } };
}

function makeResult(summary: string): import("../../src/workflows/types.ts").WorkflowResult {
	return { version: 1, summary: { text: summary, covers: [], omissions: [], confidence: "high" }, outputs: { result: { kind: "value", value: summary } }, diagnostics: { gaps: [], conflicts: [], warnings: [] }, recommendations: [] };
}

const started: WorkflowEvent = {
	id: "event-1",
	type: "workflow.started",
	at: 1,
	runId: "workflow-1",
	mode: "deep-research",
	goal: "Compare Dynamic Workflow implementations",
	cwd: "/repo",
	sessionId: "session-1",
	branch: "main",
};

const planned: WorkflowEvent = {
	id: "event-2",
	type: "workflow.plan_applied",
	at: 2,
	tasks: [{ id: "task-research", label: "Research and synthesis", order: 0 }],
	workUnits: [
		{
			id: "research-a",
			taskId: "task-research",
			kind: "research",
			label: "Research architecture",
			order: 0,
			dependsOn: [],
			agentSpec: agentSpec("agent-research-a", "researcher"),
			dataContract: researchContract(),
		},
		{
			id: "writer",
			taskId: "task-research",
			kind: "writer",
			label: "Write accepted findings",
			order: 1,
			dependsOn: ["research-a"],
			agentSpec: agentSpec("agent-writer", "research-writer"),
			dataContract: writerContract(),
		},
	],
};

function documentOutline(approval: DocumentOutline["approval"], writerNodeIds: [string, string]): DocumentOutline {
	return {
		version: 0,
		title: "Repairable report",
		thesis: "Durable workflows need explicit recovery contracts.",
		approval,
		sections: [
			{ id: "background", title: "Background", objective: "Explain context", questions: ["Why?"], evidenceRequirements: ["Primary sources"], targetWords: 500, writerNodeId: writerNodeIds[0] },
			{ id: "mechanism", title: "Mechanism", objective: "Explain recovery", questions: ["How?"], evidenceRequirements: ["Implementation evidence"], targetWords: 500, writerNodeId: writerNodeIds[1] },
		],
	};
}

function sectionWriterNode(id: string): WorkflowWorkUnitPlan {
	return {
		id,
		taskId: "task-sections",
		kind: "section-writer",
		label: id,
		order: 0,
		dependsOn: [],
		agentSpec: agentSpec(`agent-${id}`, "research-section-writer"),
		dataContract: sectionWriterContract(),
	};
}

describe("workflow reducer", () => {
	it("makes dependants ready only after dependency results are accepted", () => {
		let run = reduceWorkflowEvents([started, planned]);
		assert.equal(run.nodes["research-a"]?.status, "ready");
		assert.equal(run.nodes.writer?.status, "pending");

		run = reduceWorkflowEvent(run, {
			id: "event-3",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-1", number: 1, startedAt: 3 },
		});
		run = reduceWorkflowEvent(run, {
			id: "event-4",
			type: "node.completed",
			at: 4,
			nodeId: "research-a",
			attemptId: "research-a:1",
			result: {
				summary: "Architecture evidence collected",
				findings: [],
				gaps: [],
				conflicts: [],
				recommendations: [],
				artifactPaths: [],
			},
		});

		assert.equal(run.nodes["research-a"]?.status, "completed");
		assert.equal(run.nodes.writer?.status, "pending");

		const acceptedEvent: WorkflowEvent = {
			id: "event-5",
			type: "node.accepted",
			at: 5,
			nodeId: "research-a",
			decision: "Evidence is sufficient for synthesis.",
		};
		run = reduceWorkflowEvent(run, acceptedEvent);

		assert.equal(run.nodes["research-a"]?.status, "accepted");
		assert.equal(run.nodes.writer?.status, "ready");
		assert.equal(run.revision, 5);

		const replayed = reduceWorkflowEvent(run, acceptedEvent);
		assert.deepEqual(replayed, run);
	});

	it("supersedes an accepted node with an accepted same-kind replacement and preserves audit history", () => {
		const originalPlan: WorkflowEvent = {
			...planned,
			id: "event-plan",
			workUnits: [
				planned.workUnits[0]!,
				{ ...planned.workUnits[0]!, id: "research-v2", label: "Corrected research", order: 1, agentSpec: agentSpec("agent-research-v2", "researcher"), dataContract: researchContract() },
				{ ...planned.workUnits[1]!, order: 2 },
			],
		};
		let run = reduceWorkflowEvents([started, originalPlan]);
		for (const [nodeId, startAt] of [["research-a", 3], ["research-v2", 6]] as const) {
			run = reduceWorkflowEvent(run, {
				id: `event-start-${nodeId}`,
				type: "node.started",
				at: startAt,
				nodeId,
				attempt: { attemptId: `${nodeId}:1`, requestId: `request-${nodeId}`, number: 1, startedAt: startAt },
			});
			run = reduceWorkflowEvent(run, {
				id: `event-complete-${nodeId}`,
				type: "node.completed",
				at: startAt + 1,
				nodeId,
				attemptId: `${nodeId}:1`,
				result: makeResult(nodeId),
			});
			run = reduceWorkflowEvent(run, { id: `event-accept-${nodeId}`, type: "node.accepted", at: startAt + 2, nodeId, decision: "accepted" });
		}
		run = reduceWorkflowEvent(run, {
			id: "event-supersede",
			type: "node.superseded",
			at: 9,
			nodeId: "research-a",
			replacementNodeId: "research-v2",
			decision: "The replacement restores the required provenance.",
		});

		assert.equal(run.nodes["research-a"]?.status, "superseded");
		assert.equal(run.nodes["research-a"]?.supersededBy, "research-v2");
		assert.equal(run.nodes["research-a"]?.result?.summary.text, "research-a");
		assert.equal(run.nodes["research-v2"]?.status, "accepted");
		assert.equal(run.nodes.writer?.status, "ready");
	});

	it("supersedes a failed node with an accepted same-kind replacement and retains the failed attempt", () => {
		const replacementPlan: WorkflowEvent = {
			...planned,
			id: "event-plan-replacement",
			workUnits: [
				planned.workUnits[0]!,
				{ ...planned.workUnits[0]!, id: "research-v2", label: "Replacement", order: 1, agentSpec: agentSpec("agent-research-v2", "researcher"), dataContract: researchContract() },
			],
		};
		let run = reduceWorkflowEvents([started, replacementPlan]);
		run = reduceWorkflowEvent(run, { id: "event-start-old", type: "node.started", at: 3, nodeId: "research-a", attempt: { attemptId: "research-a:1", requestId: "request-old", number: 1, startedAt: 3 } });
		run = reduceWorkflowEvent(run, { id: "event-fail-old", type: "node.failed", at: 4, nodeId: "research-a", attemptId: "research-a:1", error: "timed out" });
		run = reduceWorkflowEvent(run, { id: "event-start-v2", type: "node.started", at: 5, nodeId: "research-v2", attempt: { attemptId: "research-v2:1", requestId: "request-v2", number: 1, startedAt: 5 } });
		run = reduceWorkflowEvent(run, { id: "event-complete-v2", type: "node.completed", at: 6, nodeId: "research-v2", attemptId: "research-v2:1", result: makeResult("replacement") });
		run = reduceWorkflowEvent(run, { id: "event-accept-v2", type: "node.accepted", at: 7, nodeId: "research-v2", decision: "accepted" });
		run = reduceWorkflowEvent(run, { id: "event-supersede-old", type: "node.superseded", at: 8, nodeId: "research-a", replacementNodeId: "research-v2", decision: "replacement covers failure" });

		assert.equal(run.nodes["research-a"]?.status, "superseded");
		assert.equal(run.nodes["research-a"]?.supersededBy, "research-v2");
		assert.equal(run.nodes["research-a"]?.attempts[0]?.error, "timed out");
	});

	it("rejects invalid non-terminal supersession", () => {
		const run = reduceWorkflowEvents([started, planned]);
		assert.throws(() => reduceWorkflowEvent(run, {
			id: "event-supersede-unaccepted",
			type: "node.superseded",
			at: 3,
			nodeId: "research-a",
			replacementNodeId: "writer",
			decision: "invalid",
		}), /must reach a terminal status before supersession/);
	});

	it("rejects dependency cycles before mutating the run", () => {
		const run = reduceWorkflowEvents([started]);
		assert.throws(
			() => reduceWorkflowEvent(run, {
				id: "event-cycle",
				type: "workflow.plan_applied",
				at: 2,
				tasks: [{ id: "task-cycle", label: "Cycle", order: 0 }],
				workUnits: [
					{ id: "a", taskId: "task-cycle", kind: "research", label: "A", order: 0, dependsOn: ["b"], agentSpec: agentSpec("agent-a", "researcher"), dataContract: researchContract() },
					{ id: "b", taskId: "task-cycle", kind: "research", label: "B", order: 1, dependsOn: ["a"], agentSpec: agentSpec("agent-b", "researcher"), dataContract: researchContract() },
				],
			}),
			/Dependency cycle detected/,
		);
		assert.equal(run.revision, 1);
		assert.deepEqual(run.nodes, {});
	});

	it("rejects incorrect Deep Research verifier, Writer, and Reviewer base agents before execution", () => {
		const run = reduceWorkflowEvents([started]);
		for (const [kind, baseAgent, required] of [
			["verification", "researcher", "research-verifier"],
			["writer", "writer", "research-writer"],
			["reviewer", "reviewer", "research-reviewer"],
		] as const) {
			assert.throws(
				() => reduceWorkflowEvent(run, {
					id: `event-${kind}`,
					type: "workflow.plan_applied",
					at: 2,
					tasks: [{ id: "task-role", label: "Role validation", order: 0 }],
					workUnits: [{ id: kind, taskId: "task-role", kind, label: kind, order: 0, dependsOn: [], agentSpec: agentSpec(`agent-${kind}`, baseAgent), dataContract: researchContract() }],
				}),
				new RegExp(`must use baseAgent '${required}'`),
			);
		}
		assert.equal(run.revision, 1);
	});

	it("allows the Supervisor to reject obsolete failed and pending nodes", () => {
		let run = reduceWorkflowEvents([started, planned]);
		run = reduceWorkflowEvent(run, {
			id: "event-start-writer-prerequisite",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-research", number: 1, startedAt: 3 },
		});
		run = reduceWorkflowEvent(run, {
			id: "event-fail-research",
			type: "node.failed",
			at: 4,
			nodeId: "research-a",
			attemptId: "research-a:1",
			error: "preflight failed",
		});
		run = reduceWorkflowEvent(run, { id: "event-reject-failed", type: "node.rejected", at: 5, nodeId: "research-a", decision: "Replaced by a corrected lane." });
		run = reduceWorkflowEvent(run, { id: "event-reject-pending", type: "node.rejected", at: 6, nodeId: "writer", decision: "Its dependency was superseded." });

		assert.equal(run.nodes["research-a"]?.status, "rejected");
		assert.equal(run.nodes.writer?.status, "rejected");
	});

	it("allows a user-approved ownership repair after rejected Section Writers are replaced", () => {
		const originalOutline = documentOutline("user", ["section-a", "section-b"]);
		let run = reduceWorkflowEvents([
			started,
			{ id: "event-outline", type: "workflow.outline_set", at: 2, outline: originalOutline },
			{ id: "event-plan-writers", type: "workflow.plan_applied", at: 3, tasks: [{ id: "task-sections", label: "Write sections", order: 0 }], workUnits: [sectionWriterNode("section-a"), sectionWriterNode("section-b")] },
		]);
		run = reduceWorkflowEvent(run, {
			id: "event-start-section-a",
			type: "node.started",
			at: 4,
			nodeId: "section-a",
			attempt: { attemptId: "section-a:1", requestId: "request-section-a", number: 1, startedAt: 4 },
		});
		run = reduceWorkflowEvent(run, { id: "event-fail-section-a", type: "node.failed", at: 5, nodeId: "section-a", attemptId: "section-a:1", error: "invalid envelope" });
		run = reduceWorkflowEvent(run, { id: "event-reject-section-a", type: "node.rejected", at: 6, nodeId: "section-a", decision: "Use a corrected replacement." });
		run = reduceWorkflowEvent(run, { id: "event-reject-section-b", type: "node.rejected", at: 7, nodeId: "section-b", decision: "Use a corrected replacement." });
		run = reduceWorkflowEvent(run, {
			id: "event-plan-replacements",
			type: "workflow.plan_applied",
			at: 8,
			tasks: [{ id: "task-sections", label: "Write sections", order: 0 }],
			workUnits: [sectionWriterNode("section-a-r2"), sectionWriterNode("section-b-r2")],
		});

		const repairedOutline = documentOutline("user", ["section-a-r2", "section-b-r2"]);
		run = reduceWorkflowEvent(run, { id: "event-repair-outline", type: "workflow.outline_set", at: 9, outline: repairedOutline });
		assert.deepEqual(run.documentOutline, repairedOutline);
	});

	it("rejects post-writing outline edits that bypass user approval or change document content", () => {
		const originalOutline = documentOutline("user", ["section-a", "section-b"]);
		let run = reduceWorkflowEvents([
			started,
			{ id: "event-outline", type: "workflow.outline_set", at: 2, outline: originalOutline },
			{ id: "event-plan-writers", type: "workflow.plan_applied", at: 3, tasks: [{ id: "task-sections", label: "Write sections", order: 0 }], workUnits: [sectionWriterNode("section-a"), sectionWriterNode("section-b"), sectionWriterNode("section-a-r2"), sectionWriterNode("section-b-r2")] },
		]);
		run = reduceWorkflowEvent(run, {
			id: "event-start-section-a",
			type: "node.started",
			at: 4,
			nodeId: "section-a",
			attempt: { attemptId: "section-a:1", requestId: "request-section-a", number: 1, startedAt: 4 },
		});
		run = reduceWorkflowEvent(run, { id: "event-fail-section-a", type: "node.failed", at: 5, nodeId: "section-a", attemptId: "section-a:1", error: "invalid envelope" });
		run = reduceWorkflowEvent(run, { id: "event-reject-section-a", type: "node.rejected", at: 6, nodeId: "section-a", decision: "Use a corrected replacement." });
		run = reduceWorkflowEvent(run, { id: "event-reject-section-b", type: "node.rejected", at: 7, nodeId: "section-b", decision: "Use a corrected replacement." });

		assert.throws(
			() => reduceWorkflowEvent(run, { id: "event-supervisor-repair", type: "workflow.outline_set", at: 8, outline: documentOutline("supervisor", ["section-a-r2", "section-b-r2"]) }),
			/Only a user-approved ownership repair/,
		);
		const changedContent = documentOutline("user", ["section-a-r2", "section-b-r2"]);
		changedContent.sections[0]!.objective = "Rewrite the approved objective";
		assert.throws(
			() => reduceWorkflowEvent(run, { id: "event-content-rewrite", type: "workflow.outline_set", at: 9, outline: changedContent }),
			/Only a user-approved ownership repair/,
		);
	});

	it("enforces the persisted attempt ceiling at the reducer boundary", () => {
		for (const terminalStatus of ["failed", "cancelled"] as const) {
			let run = reduceWorkflowEvents([{ ...started, maxNodeAttempts: 3 }, planned]);
			for (let number = 1; number <= 3; number++) {
				run = reduceWorkflowEvent(run, {
					id: `event-${terminalStatus}-start-${number}`,
					type: "node.started",
					at: number * 2 + 1,
					nodeId: "research-a",
					attempt: { attemptId: `research-a:${number}`, requestId: `request-${terminalStatus}-${number}`, number, startedAt: number * 2 + 1 },
				});
				run = terminalStatus === "failed"
					? reduceWorkflowEvent(run, { id: `event-failed-${number}`, type: "node.failed", at: number * 2 + 2, nodeId: "research-a", attemptId: `research-a:${number}`, error: "failed" })
					: reduceWorkflowEvent(run, { id: `event-cancelled-${number}`, type: "node.cancelled", at: number * 2 + 2, nodeId: "research-a", attemptId: `research-a:${number}`, error: "cancelled" });
			}
			assert.throws(() => reduceWorkflowEvent(run, {
				id: `event-${terminalStatus}-start-4`,
				type: "node.started",
				at: 10,
				nodeId: "research-a",
				attempt: { attemptId: "research-a:4", requestId: `request-${terminalStatus}-4`, number: 4, startedAt: 10 },
			}), /reached its 3-attempt ceiling.*Supervisor intervention/i);
		}
	});

	it("keeps attempts immutable after a terminal result", () => {
		let run = reduceWorkflowEvents([started, planned]);
		run = reduceWorkflowEvent(run, {
			id: "event-attempt-start",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-1", number: 1, startedAt: 3 },
		});
		run = reduceWorkflowEvent(run, {
			id: "event-attempt-complete",
			type: "node.completed",
			at: 4,
			nodeId: "research-a",
			attemptId: "research-a:1",
			result: {
				summary: "First result",
				findings: [],
				gaps: [],
				conflicts: [],
				recommendations: [],
				artifactPaths: [],
			},
		});

		assert.throws(
			() => reduceWorkflowEvent(run, {
				id: "event-attempt-overwrite",
				type: "node.completed",
				at: 5,
				nodeId: "research-a",
				attemptId: "research-a:1",
				result: {
					summary: "Overwritten result",
					findings: [],
					gaps: [],
					conflicts: [],
					recommendations: [],
					artifactPaths: [],
				},
			}),
			/attempt is already terminal/,
		);
	});

	it("clears the temporary waiting reason when the same attempt completes", () => {
		let run = reduceWorkflowEvents([started, planned]);
		run = reduceWorkflowEvent(run, {
			id: "event-waiting-start",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-waiting", number: 1, startedAt: 3 },
		});
		run = reduceWorkflowEvent(run, {
			id: "event-waiting",
			type: "node.waiting",
			at: 4,
			nodeId: "research-a",
			attemptId: "research-a:1",
			reason: "Waiting for supervisor input.",
			childRunId: "child-1",
			structuredOutputPath: "/tmp/output.json",
			metadataPath: "/tmp/meta.json",
		});
		run = reduceWorkflowEvent(run, {
			id: "event-waiting-completed",
			type: "node.completed",
			at: 5,
			nodeId: "research-a",
			attemptId: "research-a:1",
			result: {
				summary: "Completed after supervisor input",
				findings: [],
				gaps: [],
				conflicts: [],
				recommendations: [],
				artifactPaths: [],
			},
			childRunId: "child-1",
		});

		const completed = run.nodes["research-a"]?.attempts[0];
		assert.equal(completed?.status, "completed");
		assert.equal(completed?.error, undefined);
		assert.equal(completed?.structuredOutputPath, "/tmp/output.json");
		assert.equal(completed?.metadataPath, "/tmp/meta.json");
	});

	it("enforces the cumulative work-unit budget and rejects over-budget apply_plan", () => {
		const budgetStarted: WorkflowEvent = {
			id: "event-budget-start",
			type: "workflow.started",
			at: 1,
			runId: "workflow-budget",
			mode: "deep-research",
			goal: "Budget test",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			maxNodes: 2,
		};
		const budgetRun = reduceWorkflowEvents([budgetStarted]);
		const first = reduceWorkflowEvent(budgetRun, {
			id: "event-2",
			type: "workflow.plan_applied",
			at: 2,
			tasks: [{ id: "task-research", label: "Research", order: 0 }],
			workUnits: [
				{ id: "research-a", taskId: "task-research", kind: "research", label: "a", order: 0, dependsOn: [], agentSpec: agentSpec("agent-a", "researcher"), dataContract: researchContract() },
				{ id: "research-b", taskId: "task-research", kind: "research", label: "b", order: 1, dependsOn: [], agentSpec: agentSpec("agent-b", "researcher"), dataContract: researchContract() },
			],
		});
		assert.equal(Object.keys(first.nodes).length, 2);
		assert.throws(() => reduceWorkflowEvent(first, {
			id: "event-3",
			type: "workflow.plan_applied",
			at: 3,
			tasks: [{ id: "task-repair", label: "Repair", order: 1 }],
			workUnits: [
				{ id: "research-c", taskId: "task-repair", kind: "research", label: "c", order: 0, dependsOn: [], agentSpec: agentSpec("agent-c", "researcher"), dataContract: researchContract() },
			],
		}), /budget exceeded/);
		// Replacing an existing node (same id) does not grow the budget.
		const replaced = reduceWorkflowEvent(first, {
			id: "event-4",
			type: "workflow.plan_applied",
			at: 4,
			tasks: [{ id: "task-repair", label: "Repair", order: 1 }],
			workUnits: [
				{ id: "research-a", taskId: "task-repair", kind: "research", label: "a2", order: 0, dependsOn: [], agentSpec: agentSpec("agent-a2", "researcher"), dataContract: researchContract() },
			],
		});
		assert.equal(Object.keys(replaced.nodes).length, 2);
	});
});
