import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { benchmarkResearchLanes, summarizeSearchBenchmarkRuns } from "../../src/workflows/benchmark.ts";
import { buildWorkflowRepairGuidance, formatWorkflowRepairGuidance } from "../../src/workflows/guidance.ts";
import { evaluateWorkflow } from "../../src/workflows/gates.ts";
import { resolveWorkflowPolicy } from "../../src/workflows/policy.ts";
import { assessWorkflowQuality } from "../../src/workflows/quality.ts";
import type { WorkflowFinding, WorkflowResult, WorkflowNode, WorkflowRun } from "../../src/workflows/types.ts";

function envelope(partial: Partial<WorkflowResult> & { findings: WorkflowFinding[] }): WorkflowResult {
	return {
		version: 1,
		summary: { text: partial.summary?.text ?? "summary", covers: [], omissions: [], confidence: "high" },
		outputs: { result: { kind: "value", value: partial.summary?.text ?? "summary" } },
		diagnostics: { gaps: (partial as { gaps?: unknown }).gaps as never ?? [], conflicts: (partial as { conflicts?: unknown }).conflicts as never ?? [], warnings: [] },
		recommendations: partial.recommendations ?? [],
		evidence: { findings: partial.findings, ...(partial.evidence?.search ? { search: partial.evidence.search } : {}) },
	};
}

function accepted(id: string, kind: WorkflowNode["kind"], result: WorkflowResult, status: WorkflowNode["status"] = "accepted"): WorkflowNode {
	return {
		id,
		kind,
		label: id,
		dependsOn: [],
		status,
		dataContract: { version: 1, profile: "research", inputs: [], outputs: { result: { mediaType: "application/json", description: "result", storage: "artifact", required: true, classification: "internal" } } },
		attempts: status === "accepted" || status === "completed" || status === "running" || status === "waiting" || status === "failed" || status === "cancelled"
			? [{
				attemptId: `${id}:1`,
				requestId: `request-${id}`,
				number: 1,
				startedAt: 1,
				completedAt: 2,
				status: status === "completed" || status === "accepted" ? "completed" : status === "waiting" ? "waiting" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "running",
				result,
				childRunId: `child-${id}`,
				launchContractDigest: `digest-${id}`,
			}]
			: [],
		...(status === "accepted" || status === "completed" ? { result } : {}),
		...(status === "accepted" ? { decision: "accepted" } : {}),
		agentSpec: {
			id: `agent-${id}`,
			baseAgent: kind === "writer" ? "research-writer" : kind === "reviewer" ? "research-reviewer" : kind === "verification" ? "research-verifier" : "researcher",
			role: kind,
			objective: id,
			instructions: id,
			context: "fresh",
		},
	};
}

function run(nodes: WorkflowNode[], decisions: WorkflowRun["decisions"] = []): WorkflowRun {
	return {
		version: 0,
		id: "workflow-guidance",
		mode: "deep-research",
		goal: "Pi dynamic workflow recoverability",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 4,
		createdAt: 1,
		updatedAt: 4,
		nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
		decisions,
		appliedEventIds: ["started"],
	};
}

describe("workflow repair guidance and search benchmark fixtures", () => {
	it("prioritizes adjudication, conflict verifiers, and follow-up queries", () => {
		const workflow = run([
			accepted("completed-research", "research", envelope({
				findings: [{ claim: "ready claim", confidence: "high", evidence: [{ url: "https://docs.example/ready", kind: "primary", quote: "ready" }] }],
			}), "completed"),
			accepted("research-a", "research", envelope({
				findings: [{ claim: "claim a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a" }] }],
				gaps: [{ question: "Does restart resume ready nodes?", reason: "No direct validation yet" }],
				conflicts: [{ statement: "QuickJS is required in V0", alternatives: ["required", "not required"], evidence: ["https://docs.example/a"] }],
				search: { queries: ["claim a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
		]);
		const evaluation = evaluateWorkflow(workflow);
		const guidance = buildWorkflowRepairGuidance(workflow, evaluation);
		assert.equal(guidance.actions[0]?.kind, "adjudicate_node");
		assert.ok(guidance.actions.some((action) => action.kind === "spawn_verifier" && action.target.includes("QuickJS")));
		assert.ok(guidance.followUpQueries.some((query) => query.toLowerCase().includes("restart")));
		const text = formatWorkflowRepairGuidance(guidance);
		assert.match(text, /Repair guidance/);
		assert.match(text, /Suggested follow-up queries/);
	});

	it("marks non-public gaps as accepted uncertainty candidates", () => {
		const workflow = run([
			accepted("research-a", "research", envelope({
				findings: [{ claim: "claim a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a" }] }],
				gaps: [{ question: "What is the private roadmap?", reason: "not public" }],
				search: { queries: ["claim a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
		]);
		const guidance = buildWorkflowRepairGuidance(workflow, evaluateWorkflow(workflow));
		assert.ok(guidance.actions.some((action) => action.kind === "record_uncertainty" && action.target.includes("private roadmap")));
	});

	it("recommends replacement instead of retry for non-retryable provider failures", () => {
		const failed = accepted("quota", "research", envelope({ findings: [] }), "failed");
		failed.agentSpec.model = "deepseek/deepseek-v4-flash:medium";
		failed.attempts[0]!.error = '402: {"message":"Insufficient Balance"}';
		failed.attempts[0]!.failure = {
			failureClass: "provider_quota_exhausted",
			retryable: false,
			pauseWorkflow: true,
			suggestedAction: "Add balance or replace the node.",
		};
		const workflow = run([failed]);
		workflow.status = "paused";
		const guidance = buildWorkflowRepairGuidance(workflow, evaluateWorkflow(workflow));
		assert.ok(!guidance.actions.some((action) => action.kind === "run_ready" && action.target === "quota"));
		const intervention = guidance.actions.find((action) => action.kind === "supervisor_intervention" && action.target === "quota");
		assert.ok(intervention);
		assert.match(intervention.reason, /provider_quota_exhausted/);
		assert.ok(intervention.kind === "supervisor_intervention" && intervention.promptHints.some((hint) => hint.includes("replaces='quota'")));
	});

	it("attaches searchBenchmark and follow-up queries to quality reports when blocked", () => {
		const weak = run([
			accepted("weak", "research", envelope({
				findings: [
					{ claim: "snippet only", confidence: "low", evidence: [{ title: "seo" }] },
					{ claim: "dup", confidence: "medium", evidence: [{ url: "https://community.example/x", kind: "community" }] },
				],
				gaps: [{ question: "Need primary source?", reason: "community only" }],
				search: { queries: ["weak"], fetchedUrls: [], droppedSources: [] },
			})),
		]);
		const report = assessWorkflowQuality(weak);
		assert.equal(report.releaseReady, false);
		assert.ok(report.searchBenchmark);
		assert.ok((report.searchBenchmark?.unsupportedClaimRate ?? 0) > 0);
		assert.ok((report.recommendedFollowUpQueries?.length ?? 0) > 0);
	});

	it("keeps verifier source reuse out of the research search benchmark", () => {
		const workflow = run([
			accepted("research-a", "research", envelope({
				findings: [{ claim: "claim a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a" }] }],
				search: { queries: ["claim a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
			accepted("verify-a", "verification", envelope({
				findings: [{ claim: "verified a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a again" }] }],
				search: { queries: ["verify a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
		]);
		const guidance = buildWorkflowRepairGuidance(workflow, evaluateWorkflow(workflow));
		assert.equal(guidance.searchBenchmark?.lanes, 1);
		assert.equal(guidance.searchBenchmark?.duplicateSourceRate, 0);
		assert.match(formatWorkflowRepairGuidance(guidance), /accepted research lanes/);
	});

	it("scores strong fixture lanes higher than weak SEO-heavy lanes", () => {
		const weak = benchmarkResearchLanes([
			{
				id: "weak",
				findings: [
					{ claim: "uncited", confidence: "low", evidence: [{ title: "snippet" }] },
					{ claim: "dup1", confidence: "medium", evidence: [{ url: "https://seo.example/a", kind: "community" }] },
					{ claim: "dup2", confidence: "medium", evidence: [{ url: "https://seo.example/a", kind: "community" }] },
				],
				search: { queries: ["generic topic"], fetchedUrls: [], droppedSources: [] },
			},
		]);
		const strong = benchmarkResearchLanes([
			{
				id: "strong-a",
				findings: [
					{ claim: "official mechanism", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "mechanism" }] },
				],
				search: { queries: ["official mechanism site:docs.example"], fetchedUrls: ["https://docs.example/a"], droppedSources: [{ url: "https://seo.example/a", reason: "seo duplicate" }] },
			},
			{
				id: "strong-b",
				findings: [
					{ claim: "source code proof", confidence: "high", evidence: [{ url: "https://github.com/example/pi/blob/main/x.ts", kind: "primary", quote: "guard" }] },
				],
				search: { queries: ["source code proof"], fetchedUrls: ["https://github.com/example/pi/blob/main/x.ts"], droppedSources: [] },
			},
		]);
		assert.ok(strong.score > weak.score);
		assert.ok(strong.claimSupportRate > weak.claimSupportRate);
		assert.ok(strong.fetchedCoverage > weak.fetchedCoverage);
		assert.ok(strong.sourceDiversity >= weak.sourceDiversity);
	});

	it("demotes gap repair actions when policy allows unresolved gaps", () => {
		const policy = resolveWorkflowPolicy("deep-research", {
			gates: { maxUnresolvedGaps: 2, maxUnresolvedConflicts: 0, minAcceptedResearchLanes: 0, requireWriter: false, requireReviewer: false },
		});
		const workflow = run([
			accepted("research-a", "research", envelope({
				findings: [{ claim: "claim a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a" }] }],
				gaps: [{ question: "Open detail?", reason: "needs source" }],
				search: { queries: ["claim a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
		], []);
		workflow.policy = policy;
		const guidance = buildWorkflowRepairGuidance(workflow, evaluateWorkflow(workflow, policy), policy);
		const gapActions = guidance.actions.filter((action) => action.target.includes("Open detail"));
		assert.ok(gapActions.every((action) => action.priority <= 40));
	});

	it("summarizes repeated provider and query-strategy benchmark runs", () => {
		const strong = benchmarkResearchLanes([{
			findings: [{ claim: "supported", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "proof" }] }],
			search: { queries: ["supported official"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
		}]);
		const weak = benchmarkResearchLanes([{
			findings: [{ claim: "unsupported", confidence: "low", evidence: [{ title: "snippet" }] }],
			search: { queries: ["generic"], fetchedUrls: [], droppedSources: [] },
		}]);
		const summary = summarizeSearchBenchmarkRuns([
			{ questionId: "q1", variant: "planned", provider: "grok", result: strong },
			{ questionId: "q1", variant: "planned", provider: "grok", result: strong },
			{ questionId: "q1", variant: "generic", provider: "grok", result: weak },
		]);

		assert.equal(summary.groups.length, 2);
		assert.equal(summary.groups[0]?.variant, "planned");
		assert.ok((summary.groups[0]?.meanScore ?? 0) > (summary.groups[1]?.meanScore ?? 100));
		assert.equal(summary.groups[0]?.runs, 2);
		assert.equal(summary.groups[0]?.scoreStdDev, 0);
	});

	it("does not recommend repair or follow-up search after the workflow is terminal", () => {
		const workflow = run([]);
		workflow.status = "completed";
		const guidance = buildWorkflowRepairGuidance(workflow, evaluateWorkflow(workflow));
		assert.deepEqual(guidance.actions, []);
		assert.deepEqual(guidance.followUpQueries, []);
		assert.match(guidance.summary, /terminal=completed/);
	});

	it("exposes a machine-readable recommendedAction consistent with nextAction", () => {
		const workflow = run([
			accepted("research-a", "research", envelope({
				findings: [{ claim: "claim a", confidence: "high", evidence: [{ url: "https://docs.example/a", kind: "primary", quote: "a" }] }],
				search: { queries: ["claim a"], fetchedUrls: ["https://docs.example/a"], droppedSources: [] },
			})),
			accepted("completed-research", "research", envelope({
				findings: [{ claim: "ready claim", confidence: "high", evidence: [{ url: "https://docs.example/ready", kind: "primary", quote: "ready" }] }],
			}), "completed"),
		]);
		const evaluation = evaluateWorkflow(workflow);
		const guidance = buildWorkflowRepairGuidance(workflow, evaluation);
		assert.ok(guidance.recommendedAction, "recommendedAction must be present when actions exist");
		assert.ok(guidance.recommendedAction!.kind);
		assert.ok(guidance.recommendedAction!.target);
		assert.ok(guidance.recommendedAction!.reason);
		// nextAction is evaluate_results because a completed node awaits adjudication.
		assert.equal(evaluation.nextAction, "evaluate_results");
		assert.equal(guidance.recommendedAction!.kind, "adjudicate_node");
		assert.equal(guidance.recommendedAction!.target, "completed-research");
	});

	it("recommends complete when all gates are satisfied", () => {
		const editor = accepted("editor", "editor", envelope({
			findings: [{ claim: "doc", confidence: "high", evidence: [{ url: "https://docs.example/d", kind: "primary", quote: "d" }] }],
		}));
		editor.dependsOn = [];
		const reviewer = accepted("reviewer", "reviewer", envelope({
			findings: [],
		}));
		reviewer.dependsOn = ["editor"];
		reviewer.result = {
			version: 1,
			summary: { text: "Review PASS", covers: [], omissions: [], confidence: "high" },
			outputs: {},
			diagnostics: { gaps: [], conflicts: [], warnings: [] },
			recommendations: [],
			evidence: { findings: [] },
			extensions: { release: { release: true, rationale: "Document passed review." } },
		};
		const workflow = run([editor, reviewer]);
		workflow.policy = resolveWorkflowPolicy("deep-research", {
			gates: { minAcceptedResearchLanes: 0, minAcceptedSectionWriters: 0, maxUnresolvedGaps: 0, maxUnresolvedConflicts: 0, requireBrief: false, requireOutline: false, requireWriter: false, requireEditor: false, requireReviewer: false },
		});
		const evaluation = evaluateWorkflow(workflow);
		assert.equal(evaluation.nextAction, "complete");
		const guidance = buildWorkflowRepairGuidance(workflow, evaluation);
		assert.equal(guidance.recommendedAction?.kind, "complete");
		assert.equal(guidance.recommendedAction?.target, workflow.id);
	});
});
