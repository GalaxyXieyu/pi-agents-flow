import { benchmarkResearchLanes, type SearchQualityBenchmarkResult } from "./benchmark.ts";
import { effectiveAcceptedResultNodes } from "./effective-nodes.ts";
import { suggestFollowUpQueries } from "./evidence.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import type { WorkflowEvaluation } from "./gates.ts";
import { resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import type { WorkflowRun } from "./types.ts";

export type WorkflowRepairAction =
	| {
		kind: "spawn_verifier";
		priority: number;
		reason: string;
		target: string;
		promptHints: string[];
	}
	| {
		kind: "record_uncertainty";
		priority: number;
		reason: string;
		target: string;
	}
	| {
		kind: "spawn_research_lane";
		priority: number;
		reason: string;
		target: string;
		promptHints: string[];
	}
	| {
		kind: "adjudicate_node";
		priority: number;
		reason: string;
		target: string;
	}
	| {
		kind: "run_ready";
		priority: number;
		reason: string;
		target: string;
	}
	| {
		kind: "supervisor_intervention";
		priority: number;
		reason: string;
		target: string;
		promptHints: string[];
	}
	| {
		kind: "complete";
		priority: number;
		reason: string;
		target: string;
	};

export interface WorkflowRepairGuidance {
	version: 0;
	workflowId: string;
	revision: number;
	nextAction: WorkflowEvaluation["nextAction"];
	followUpQueries: string[];
	preferredSourceHints: string[];
	actions: WorkflowRepairAction[];
	searchBenchmark?: SearchQualityBenchmarkResult;
	summary: string;
}

function acceptedResearchLanes(run: WorkflowRun) {
	return effectiveAcceptedResultNodes(run)
		.filter((node) => node.kind === "research")
		.map((node) => ({
			id: node.id,
			findings: node.result!.evidence?.findings ?? [],
			search: node.result!.evidence?.search,
		}));
}

function collectUnresolved(run: WorkflowRun) {
	const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?。！？]+$/g, "");
	const accepted = effectiveAcceptedResultNodes(run);
	const acceptedGapTargets = new Set(
		run.decisions
			.filter((decision) => decision.kind === "accepted_uncertainty" || decision.kind === "gap_resolution")
			.map((decision) => normalize(decision.target)),
	);
	const resolvedConflicts = new Set(
		run.decisions
			.filter((decision) => decision.kind === "conflict_resolution")
			.map((decision) => normalize(decision.target)),
	);
	const gaps = new Map<string, { question: string; reason: string }>();
	const conflicts = new Map<string, { statement: string; alternatives: string[]; evidence: string[] }>();
	for (const node of accepted) {
		for (const gap of node.result?.diagnostics.gaps ?? []) {
			const key = normalizeWorkflowText(gap.question);
			if (!acceptedGapTargets.has(key) && !gaps.has(key)) gaps.set(key, gap);
		}
		for (const conflict of node.result?.diagnostics.conflicts ?? []) {
			const key = normalizeWorkflowText(conflict.statement);
			if (!resolvedConflicts.has(key) && !conflicts.has(key)) conflicts.set(key, conflict);
		}
	}
	return {
		gaps: [...gaps.values()],
		conflicts: [...conflicts.values()],
	};
}

export function buildWorkflowRepairGuidance(
	run: WorkflowRun,
	evaluation: WorkflowEvaluation,
	policyOverride?: WorkflowPolicy,
): WorkflowRepairGuidance {
	const policy = policyOverride ?? resolveWorkflowPolicy(run.mode, run.policy);
	const preferredSourceHints = [
		"official documentation / first-party repos / specs",
		"release notes and changelogs for version claims",
		"reproducible benchmarks or source code for mechanism claims",
		"drop SEO listicles and syndicated copies after recording droppedSources",
	];
	if (run.status === "completed" || run.status === "stopped" || run.status === "failed") {
		const lanes = acceptedResearchLanes(run);
		const searchBenchmark = lanes.length > 0 ? benchmarkResearchLanes(lanes) : undefined;
		return {
			version: 0,
			workflowId: run.id,
			revision: run.revision,
			nextAction: evaluation.nextAction,
			followUpQueries: [],
			preferredSourceHints,
			actions: [],
			...(searchBenchmark ? { searchBenchmark } : {}),
			summary: `terminal=${run.status} | gaps=${evaluation.gaps} | conflicts=${evaluation.conflicts}${searchBenchmark ? ` | searchScore=${searchBenchmark.score}` : ""}`,
		};
	}
	const unresolved = collectUnresolved(run);
	const followUpQueries = suggestFollowUpQueries({
		goal: run.goal,
		gaps: unresolved.gaps,
		conflicts: unresolved.conflicts,
	});
	const actions: WorkflowRepairAction[] = [];
	const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
	const exhausted = Object.values(run.nodes).filter((node) => workflowNodeAttemptsExhausted(node, maxNodeAttempts));
	for (const node of exhausted) {
		const retained = node.attempts.flatMap((attempt) => [
			attempt.structuredOutputPath,
			attempt.metadataPath,
			...(attempt.artifactPaths ?? []),
		].filter((value): value is string => Boolean(value)));
		actions.push({
			kind: "supervisor_intervention",
			priority: 110,
			reason: `Node used all ${maxNodeAttempts} configured attempt(s); automatic retry is disabled.`,
			target: node.id,
			promptHints: [
				"Inspect retained structured output and artifacts before launching any replacement.",
				retained.length > 0 ? `Retained paths: ${[...new Set(retained)].join(", ")}` : "No persisted result artifact was recorded; inspect attempt errors and metadata before deciding.",
				"Prefer accepting a salvaged completion or reusing an accepted equivalent result; otherwise reject/supersede and create one bounded replacement node, or stop.",
			],
		});
	}
	const retryableFailures = Object.values(run.nodes).filter((node) => (node.status === "failed" || node.status === "cancelled") && !workflowNodeAttemptsExhausted(node, maxNodeAttempts));
	for (const node of retryableFailures) {
		actions.push({
			kind: "run_ready",
			priority: 90,
			reason: `Retry only this failed/cancelled node explicitly with run_ready nodeId='${node.id}' (${node.attempts.length}/${maxNodeAttempts}); do not launch unrelated failures.`,
			target: node.id,
		});
	}
	const awaiting = Object.values(run.nodes).filter((node) => node.status === "completed");
	for (const node of awaiting) {
		actions.push({
			kind: "adjudicate_node",
			priority: 100,
			reason: "Completed node still needs accept/reject before dependents can proceed.",
			target: node.id,
		});
	}
	if (evaluation.ready > 0) {
		actions.push({
			kind: "run_ready",
			priority: 90,
			reason: `${evaluation.ready} node(s) are ready to execute.`,
			target: Object.values(run.nodes).filter((node) => node.status === "ready").map((node) => node.id).join(", "),
		});
	}
	for (const conflict of unresolved.conflicts) {
		actions.push({
			kind: "spawn_verifier",
			priority: 80,
			reason: "Material conflict remains unresolved and needs targeted verification.",
			target: conflict.statement,
			promptHints: [
				`Resolve whether these alternatives can both be true: ${conflict.alternatives.join(" | ")}`,
				"Prefer primary sources already registered in evidence, then one narrow follow-up search if needed.",
				"Return a ResultEnvelope with the resolved claim or an explicit remaining conflict.",
			],
		});
	}
	for (const gap of unresolved.gaps) {
		const lowValue = /not public|proprietary|no public|cannot be verified|paywall/i.test(gap.reason);
		if (lowValue) {
			actions.push({
				kind: "record_uncertainty",
				priority: 55,
				reason: "Gap appears non-public or low decision-value; consider accepted_uncertainty instead of another broad search.",
				target: gap.question,
			});
		} else {
			actions.push({
				kind: "spawn_verifier",
				priority: 70,
				reason: gap.reason,
				target: gap.question,
				promptHints: [
					`Investigate only: ${gap.question}`,
					"Use registered sources first; if missing, issue narrow primary-source queries.",
					"Stop when the release-critical fact is confirmed or proven unavailable.",
				],
			});
			actions.push({
				kind: "spawn_research_lane",
				priority: 60,
				reason: "Optional broader lane if the gap spans a missing research angle rather than a single fact.",
				target: gap.question,
				promptHints: followUpQueries.filter((query) => query.toLowerCase().includes(gap.question.toLowerCase().slice(0, 24)) || query.includes("primary source")).slice(0, 3),
			});
		}
	}
	if (evaluation.readyToComplete) {
		actions.push({
			kind: "complete",
			priority: 10,
			reason: "All policy gates for completion are satisfied.",
			target: run.id,
		});
	}
if (unresolved.gaps.length <= policy.gates.maxUnresolvedGaps) {
		for (const action of actions) {
			if (action.kind === "spawn_verifier" || action.kind === "spawn_research_lane") {
				// Gaps are within tolerance; keep them visible but below adjudication/run_ready.
				if (action.priority > 40) action.priority = 40;
			}
		}
	}
	if (unresolved.conflicts.length <= policy.gates.maxUnresolvedConflicts) {
		for (const action of actions) {
			if (action.kind === "spawn_verifier" && unresolved.conflicts.some((conflict) => conflict.statement === action.target)) {
				if (action.priority > 40) action.priority = 40;
			}
		}
	}
	actions.sort((left, right) => right.priority - left.priority || left.kind.localeCompare(right.kind));
	const lanes = acceptedResearchLanes(run);
	const searchBenchmark = lanes.length > 0 ? benchmarkResearchLanes(lanes) : undefined;
	const top = actions.slice(0, 3).map((action) => `${action.kind}:${action.target}`).join("; ");
	const summary = [
		`next=${evaluation.nextAction}`,
		`gaps=${unresolved.gaps.length}`,
		`conflicts=${unresolved.conflicts.length}`,
		searchBenchmark ? `searchScore=${searchBenchmark.score}` : undefined,
		top ? `topActions=${top}` : "topActions=none",
	].filter(Boolean).join(" | ");
	return {
		version: 0,
		workflowId: run.id,
		revision: run.revision,
		nextAction: evaluation.nextAction,
		followUpQueries,
		preferredSourceHints,
		actions,
		...(searchBenchmark ? { searchBenchmark } : {}),
		summary,
	};
}

export function formatWorkflowRepairGuidance(guidance: WorkflowRepairGuidance): string {
	const lines = [
		"## Repair guidance",
		guidance.summary,
	];
	if (guidance.followUpQueries.length > 0) {
		lines.push("", "Suggested follow-up queries:");
		for (const query of guidance.followUpQueries.slice(0, 6)) lines.push(`- ${query}`);
	}
	if (guidance.actions.length > 0) {
		lines.push("", "Recommended next actions:");
		for (const action of guidance.actions.slice(0, 8)) {
			lines.push(`- [${action.priority}] ${action.kind} :: ${action.target} — ${action.reason}`);
			if ("promptHints" in action) {
				for (const hint of action.promptHints.slice(0, 3)) lines.push(`  hint: ${hint}`);
			}
		}
	}
	if (guidance.searchBenchmark) {
		const bench = guidance.searchBenchmark;
		lines.push(
			"",
			"Search benchmark (accepted research lanes):",
			`- score ${bench.score}/100; support ${bench.claimSupportRate.toFixed(2)}; unsupported ${bench.unsupportedClaimRate.toFixed(2)}; diversity ${bench.sourceDiversity.toFixed(2)}; fetch ${bench.fetchedCoverage.toFixed(2)}; duplicates ${bench.duplicateSourceRate.toFixed(2)}`,
		);
	}
	lines.push("", "Source preference:", ...guidance.preferredSourceHints.map((hint) => `- ${hint}`));
	return lines.join("\n");
}
