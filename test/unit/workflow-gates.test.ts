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
		...(kind === "reviewer" && status === "accepted" ? { result: {
			version: 1,
			summary: { text: "Review passed", covers: [], omissions: [], confidence: "high" as const },
			outputs: {},
			diagnostics: { gaps: [], conflicts: [], warnings: [] },
			recommendations: [],
			review: { verdict: "pass" },
			extensions: { release: { release: true, rationale: "Document passed review." } },
		} } : {}),
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

	it("reports the missing accepted Writer when a custom policy requires one", () => {
		const research = node("research", "research", "accepted");
		const workflow: WorkflowRun = {
			version: 1,
			id: "workflow-require-writer",
			mode: "general",
			goal: "Synthesize",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			nodes: { research },
			decisions: [],
			appliedEventIds: ["started"],
		};
		const base = evaluateWorkflow(workflow).policy;
		workflow.policy = { ...base, gates: { ...base.gates, requireWriter: true } };
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.readyToComplete, false);
		assert.ok(evaluation.completionBlockers.includes("an accepted Writer is required by policy"));
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

	it("does not treat one covered owner as coverage for other outline writers", () => {
		const nodes = [
			node("research-a", "research", "accepted"), node("research-b", "research", "accepted"), node("research-c", "research", "accepted"),
			node("writer-a", "section-writer", "accepted"), node("writer-b", "section-writer", "accepted"),
			node("editor", "editor", "accepted", ["writer-a"]), node("reviewer", "reviewer", "accepted", ["editor"]),
		];
		nodes.at(-1)!.result!.extensions = { release: { release: true, rationale: "Approved." } };
		const workflow: WorkflowRun = {
			version: 0, id: "workflow-incomplete-owner-lineage", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 1, createdAt: 1, updatedAt: 1,
			researchBrief: { version: 0, audience: "Engineers", purpose: "Decision", scope: "Architecture", depth: "deep", deliverable: "research-report", targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" },
			documentOutline: { version: 0, title: "Report", thesis: "Evidence.", approval: "user", sections: [
				{ id: "a", title: "Background", objective: "Context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeIds: ["writer-a"] },
				{ id: "b", title: "Details", objective: "Mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeIds: ["writer-b"] },
			] },
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), decisions: [], appliedEventIds: ["started"],
		};
		assert.equal(evaluateWorkflow(workflow).finalEditorCoversOutline, false);
	});

	it("treats a multi-section writer as the owner of every explicitly assigned section", () => {
		const nodes = [
			node("research-a", "research", "accepted"), node("research-b", "research", "accepted"), node("research-c", "research", "accepted"),
			node("writer-a", "section-writer", "accepted"), node("writer-b", "section-writer", "accepted"),
			node("editor", "editor", "accepted", ["writer-a", "writer-b"]), node("reviewer", "reviewer", "accepted", ["editor"]),
		];
		const reviewer = nodes.at(-1)!;
		reviewer.result!.extensions = { release: { release: true, rationale: "Approved." } };
		const workflow: WorkflowRun = {
			version: 0, id: "workflow-multi-section-owner", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 1, createdAt: 1, updatedAt: 1,
			researchBrief: { version: 0, audience: "Engineers", purpose: "Decision", scope: "Architecture", depth: "deep", deliverable: "research-report", targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" },
			documentOutline: { version: 0, title: "Report", thesis: "Evidence.", approval: "user", sections: [
				{ id: "a", title: "Background", objective: "Context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeIds: ["writer-a"] },
				{ id: "b", title: "Details", objective: "Mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeIds: ["writer-a"] },
				{ id: "c", title: "Decision", objective: "Choose", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeIds: ["writer-b"] },
			] },
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), decisions: [], appliedEventIds: ["started"],
		};
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.finalEditorCoversOutline, true);
		assert.equal(evaluation.readyToComplete, true);
	});

	it("recognizes an accepted reviewed Editor repair through transitive Section Writer dependencies", () => {
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			node("editor-v1", "editor", "accepted", ["section-a", "section-b"]),
			node("reviewer-v1", "reviewer", "accepted", ["editor-v1"]),
			node("editor-repair", "editor", "accepted", ["editor-v1", "reviewer-v1"]),
			node("reviewer-repair", "reviewer", "accepted", ["editor-repair"]),
		];
		const workflow: WorkflowRun = {
			version: 0,
			id: "workflow-transitive-repair",
			mode: "deep-research",
			goal: "Research",
			cwd: "/repo",
			sessionId: "session-1",
			branch: "main",
			status: "active",
			revision: 1,
			createdAt: 1,
			updatedAt: 1,
			researchBrief: { version: 0, audience: "Engineers", purpose: "Decision", scope: "Architecture", depth: "deep", deliverable: "research-report", targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" },
			documentOutline: { version: 0, title: "Report", thesis: "Evidence.", approval: "user", sections: [
				{ id: "a", title: "Background", objective: "Context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
				{ id: "b", title: "Details", objective: "Mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
			] },
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
			decisions: [],
			appliedEventIds: ["started"],
		};
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.finalEditorNodeId, "editor-repair");
		assert.equal(evaluation.finalEditorCoversOutline, true);
		assert.equal(evaluation.reviewedFinalEditor, true);
	});

	it("selects the terminal Editor revision independently of node insertion order", () => {
		const editorV2 = node("editor-v2", "editor", "accepted", ["editor-v1"]);
		editorV2.attempts = [{ attemptId: "editor-v2:1", requestId: "r2", number: 1, startedAt: 5, completedAt: 6, status: "completed" }];
		const editorV1 = node("editor-v1", "editor", "accepted", ["section-a", "section-b"]);
		editorV1.attempts = [{ attemptId: "editor-v1:1", requestId: "r1", number: 1, startedAt: 3, completedAt: 4, status: "completed" }];
		const reviewer = node("reviewer-v2", "reviewer", "accepted", ["editor-v2"]);
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			editorV2,
			reviewer,
			editorV1,
		];
		const workflow: WorkflowRun = {
			version: 0, id: "workflow-order", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 1, createdAt: 1, updatedAt: 1,
			researchBrief: { version: 0, audience: "Engineers", purpose: "Decision", scope: "Architecture", depth: "deep", deliverable: "research-report", targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" },
			documentOutline: { version: 0, title: "Report", thesis: "Evidence.", approval: "user", sections: [
				{ id: "a", title: "Background", objective: "Context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
				{ id: "b", title: "Details", objective: "Mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
			] },
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), decisions: [], appliedEventIds: ["started"],
		};
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.finalEditorNodeId, "editor-v2");
		assert.equal(evaluation.reviewedFinalEditor, true);
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
		assert.equal(evaluation.nextAction, "resolve_gates");
		assert.ok(evaluation.completionBlockers.some((blocker) => blocker.includes("Reviewer")));
	});

	it("accepts a valid failed review without treating the document as released", () => {
		const nodes = [
			node("research-a", "research", "accepted"),
			node("research-b", "research", "accepted"),
			node("research-c", "research", "accepted"),
			node("section-a", "section-writer", "accepted"),
			node("section-b", "section-writer", "accepted"),
			node("editor", "editor", "accepted", ["section-a", "section-b"]),
		];
		const reviewer = node("reviewer", "reviewer", "accepted", ["editor"]);
		delete reviewer.result?.extensions;
		nodes.push(reviewer);
		const workflow: WorkflowRun = {
			version: 0, id: "workflow-failed-review", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 1, createdAt: 1, updatedAt: 1,
			researchBrief: { version: 0, audience: "Engineers", purpose: "Decision", scope: "Architecture", depth: "deep", deliverable: "research-report", targetWords: { min: 1000, max: 2000 }, requiredTopics: [], excludedTopics: [], constraints: [], assumptions: [], clarification: "confirmed" },
			documentOutline: { version: 0, title: "Report", thesis: "Evidence.", approval: "user", sections: [
				{ id: "a", title: "Background", objective: "Context", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-a" },
				{ id: "b", title: "Details", objective: "Mechanism", questions: [], evidenceRequirements: [], targetWords: 500, writerNodeId: "section-b" },
			] },
			nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), decisions: [], appliedEventIds: ["started"],
		};
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.reviewedFinalEditor, true);
		assert.equal(evaluation.readyToComplete, false);
		assert.equal(evaluation.nextAction, "resolve_gates");
		assert.ok(evaluation.completionBlockers.includes("the final Reviewer has not approved document release"));
	});

	it("does not release gates from a legacy reviewer artifact lacking review.verdict", () => {
		const nodes = [node("research-a", "research", "accepted"), node("research-b", "research", "accepted"), node("research-c", "research", "accepted"), node("section-a", "section-writer", "accepted"), node("section-b", "section-writer", "accepted"), node("editor", "editor", "accepted", ["section-a", "section-b"]), node("reviewer", "reviewer", "accepted", ["editor"])];
		const reviewer = nodes.at(-1)!;
		delete reviewer.result?.review;
		reviewer.result!.diagnostics.gaps = [{ question: "legacy gap", reason: "not public" }];
		const workflow: WorkflowRun = {
			version: 1, id: "workflow-legacy-review", mode: "deep-research", goal: "Research", cwd: "/repo", sessionId: "session-1", branch: "main", status: "active", revision: 1, createdAt: 1, updatedAt: 1,
			nodes: Object.fromEntries(nodes.map((candidate) => [candidate.id, candidate])), decisions: [], appliedEventIds: ["started"],
		};
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.reviewerRelease, undefined);
		assert.ok(evaluation.completionBlockers.some((blocker) => blocker.includes("unresolved evidence gap")));
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
			review: { verdict: "pass" },
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
