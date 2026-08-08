import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateWorkflow } from "../../src/workflows/gates.ts";
import type { WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

function node(id: string, kind: WorkflowNode["kind"], status: WorkflowNode["status"], dependsOn: string[] = []): WorkflowNode {
	const baseAgent = kind === "section-writer"
		? "research-section-writer"
		: kind === "editor"
			? "research-editor"
			: kind === "writer"
				? "research-writer"
		: kind === "reviewer"
			? "research-reviewer"
			: kind === "verification"
				? "research-verifier"
				: "researcher";
	return {
		id,
		kind,
		label: id,
		dependsOn,
		status,
		attempts: [],
		agentSpec: { id: `agent-${id}`, baseAgent, role: kind, objective: id, instructions: id, context: "fresh", },
		dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
	};
}

describe("workflow completion gates", () => {
	it("waits for running nodes instead of asking the supervisor to apply another plan", () => {
		const running = node("research-running", "research", "running");
		const workflow: WorkflowRun = {
			version: 0,
			id: "workflow-running",
			mode: "deep-research",
			goal: "Research",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			nodes: { [running.id]: running },
			decisions: [],
			appliedEventIds: ["started"],
		};

		assert.equal(evaluateWorkflow(workflow).nextAction, "wait_for_subagents");
	});

	it("allows explicitly rejected obsolete nodes when replacement section Writers, Editor, and Reviewer are accepted", () => {
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("writer-obsolete", "writer", "rejected"),
			node("reviewer-obsolete", "reviewer", "rejected"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			node("editor-v2", "editor", "accepted", ["section-a", "section-b"]),
			node("reviewer-v2", "reviewer", "accepted", ["editor-v2"]),
		];
		const run: WorkflowRun = {
			version: 0,
			id: "workflow-repair",
			mode: "deep-research",
			goal: "Research",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			researchBrief: {
				version: 0,
				audience: "Engineers",
				purpose: "Support a decision",
				scope: "Architecture",
				depth: "deep",
				deliverable: "research-report",
				targetWords: { min: 1000, max: 2000 },
				requiredTopics: [],
				excludedTopics: [],
				constraints: [],
				assumptions: [],
				clarification: "confirmed",
			},
			documentOutline: {
				version: 0,
				title: "Report",
				thesis: "Evidence supports the decision.",
				approval: "user",
				sections: [
					{ id: "a", title: "Background", objective: "Explain context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
					{ id: "b", title: "Technical details", objective: "Explain mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
				],
			},
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
			decisions: [],
			appliedEventIds: ["started"],
		};

		const evaluation = evaluateWorkflow(run);

		assert.equal(evaluation.accepted, 7);
		assert.equal(evaluation.rejected, 2);
		assert.equal(evaluation.readyToComplete, true);
		assert.equal(evaluation.nextAction, "complete");
	});

	it("requires the accepted Reviewer to review the final Editor revision", () => {
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			node("editor-v1", "editor", "accepted", ["section-a", "section-b"]),
			node("reviewer-v1", "reviewer", "accepted", ["editor-v1"]),
			node("editor-v2", "editor", "accepted", ["section-a", "section-b"]),
		];
		const workflow: WorkflowRun = {
			version: 0,
			id: "workflow-stale-review",
			mode: "deep-research",
			goal: "Research",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			researchBrief: {
				version: 0,
				audience: "Engineers",
				purpose: "Support a decision",
				scope: "Architecture",
				depth: "deep",
				deliverable: "research-report",
				targetWords: { min: 1000, max: 2000 },
				requiredTopics: [],
				excludedTopics: [],
				constraints: [],
				assumptions: [],
				clarification: "confirmed",
			},
			documentOutline: {
				version: 0,
				title: "Report",
				thesis: "Evidence supports the decision.",
				approval: "user",
				sections: [
					{ id: "a", title: "Background", objective: "Explain context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
					{ id: "b", title: "Technical details", objective: "Explain mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
				],
			},
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
			decisions: [],
			appliedEventIds: ["started"],
		};

		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.finalEditorNodeId, "editor-v2");
		assert.equal(evaluation.reviewedFinalEditor, false);
		assert.equal(evaluation.readyToComplete, false);
		assert.equal(evaluation.nextAction, "apply_plan");
	});

	it("releases unresolved gap/conflict gates when the final Reviewer declares acceptance", () => {
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			node("editor", "editor", "accepted", ["section-a", "section-b"]),
		];
		const reviewer = node("reviewer", "reviewer", "accepted", ["editor"]);
		reviewer.result = {
			version: 1,
			summary: { text: "Review", covers: [], omissions: [], confidence: "high" },
			outputs: {},
			diagnostics: { gaps: [{ question: "g", reason: "r" }], conflicts: [{ statement: "c", alternatives: [], evidence: [] }], warnings: [] },
			recommendations: [],
			extensions: { release: { release: true, gapsAccepted: true, conflictsAccepted: true, rationale: "Residual issues do not undermine the deliverable." } },
		};
		nodes.push(reviewer);
		const run: WorkflowRun = {
			version: 0,
			id: "workflow-reviewer-release",
			mode: "deep-research",
			goal: "Research",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			researchBrief: {
				version: 0, audience: "Engineers", purpose: "Support a decision", scope: "Architecture", depth: "deep", deliverable: "research-report",
				targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed",
			},
			documentOutline: {
				version: 0, title: "Report", thesis: "Evidence supports.", approval: "user",
				sections: [
					{ id: "a", title: "Background", objective: "Explain context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
					{ id: "b", title: "Technical details", objective: "Explain mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
				],
			},
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
			decisions: [],
			appliedEventIds: ["started"],
		};
		// Sanity: without release, the residual gap blocks completion.
		const withoutRelease = structuredClone(run);
		delete withoutRelease.nodes.reviewer!.result!.extensions;
		assert.equal(evaluateWorkflow(withoutRelease).readyToComplete, false);
		// Reviewer release unbocks completion.
		const evaluation = evaluateWorkflow(run);
		assert.equal(evaluation.reviewerRelease?.gapsAccepted, true);
		assert.equal(evaluation.readyToComplete, true);
		assert.equal(evaluation.nextAction, "complete");
	});
});
