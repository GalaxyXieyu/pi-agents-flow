import { effectiveAcceptedNodes, isAdjudicatedStatus, acceptedReviewerRelease } from "./effective-nodes.ts";
import { policyAllowsCompletion, resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import type { WorkflowNodeKind, WorkflowReviewerRelease, WorkflowRun } from "./types.ts";

export interface WorkflowEvaluation {
	totalNodes: number;
	ready: number;
	running: number;
	waiting: number;
	completedAwaitingDecision: number;
	accepted: number;
	rejected: number;
	superseded: number;
	failed: number;
	cancelled: number;
	exhausted: number;
	pending: number;
	gaps: number;
	conflicts: number;
	acceptedKinds: WorkflowNodeKind[];
	acceptedResearchLanes: number;
	acceptedSectionWriters: number;
	finalEditorNodeId?: string;
	finalEditorCoversOutline: boolean;
	reviewedFinalEditor: boolean;
	readyToComplete: boolean;
	/** Reviewer release declaration, if any, which releases specific completion gates. */
	reviewerRelease?: WorkflowReviewerRelease;
	policy: WorkflowPolicy;
	nextAction: "apply_plan" | "run_ready" | "wait_for_subagents" | "evaluate_results" | "resolve_failures" | "complete";
}

export function evaluateWorkflow(run: WorkflowRun, policyOverride?: WorkflowPolicy): WorkflowEvaluation {
	const policy = policyOverride ?? resolveWorkflowPolicy(run.mode, run.policy);
	const nodes = Object.values(run.nodes);
	const count = (status: (typeof nodes)[number]["status"]): number => nodes.filter((node) => node.status === status).length;
	const acceptedNodes = effectiveAcceptedNodes(run);
	const acceptedKinds = [...new Set(acceptedNodes.map((node) => node.kind))];
	const acceptedUncertainties = new Set(run.decisions.filter((decision) => decision.kind === "accepted_uncertainty" || decision.kind === "gap_resolution").map((decision) => normalizeWorkflowText(decision.target)));
	// `accepted_uncertainty` also counts as a conflict resolution: explicitly accepting
	// that a fact cannot be verified is a valid way to resolve a disagreement between
	// evidence sources, not just a gap acknowledgment.
	const conflictResolutions = new Set(run.decisions.filter((decision) => decision.kind === "conflict_resolution" || decision.kind === "accepted_uncertainty" || decision.kind === "gap_resolution").map((decision) => normalizeWorkflowText(decision.target)));
	const gaps = new Set(acceptedNodes.flatMap((node) => node.result?.diagnostics.gaps.map((gap) => normalizeWorkflowText(gap.question)) ?? []).filter((gap) => !acceptedUncertainties.has(gap))).size;
	const conflicts = new Set(acceptedNodes.flatMap((node) => node.result?.diagnostics.conflicts.map((conflict) => normalizeWorkflowText(conflict.statement)) ?? []).filter((conflict) => !conflictResolutions.has(conflict))).size;
	const ready = count("ready");
	const running = count("running");
	const waiting = count("waiting");
	const completedAwaitingDecision = count("completed");
	const failed = count("failed");
	const cancelled = count("cancelled");
	const pending = count("pending");
	const accepted = count("accepted");
	const rejected = count("rejected");
	const superseded = count("superseded");
	const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
	const exhausted = nodes.filter((node) => workflowNodeAttemptsExhausted(node, maxNodeAttempts)).length;
	const acceptedResearchLanes = acceptedNodes.filter((node) => node.kind === "research").length;
	const acceptedSectionWriters = acceptedNodes.filter((node) => node.kind === "section-writer").length;
	const outlineWriterIds = new Set(run.documentOutline?.sections.map((section) => section.writerNodeId) ?? []);
	const latestAcceptedEditor = acceptedNodes.filter((node) => node.kind === "editor").at(-1);
	// Track replacement chains: a writer ID is considered covered if it or any node
	// that superseded it (following the supersededBy chain) is accepted. This ensures
	// that replacing a rejected/pending writer via `replaces` still counts toward
	// outline coverage without requiring the outline to be manually updated.
	const isWriterIdCovered = (writerId: string): boolean => {
		const visited = new Set<string>();
		let current = run.nodes[writerId];
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (current.status === "accepted") return true;
			if (current.status !== "superseded" || !current.supersededBy) break;
			current = run.nodes[current.supersededBy];
		}
		return false;
	};
	const finalEditorCoversOutline = Boolean(
		latestAcceptedEditor
		&& outlineWriterIds.size > 0
		&& [...outlineWriterIds].every((writerId) =>
			latestAcceptedEditor.dependsOn.includes(writerId)
			|| latestAcceptedEditor.dependsOn.some((dep) => isWriterIdCovered(dep) && run.nodes[dep]?.kind === "section-writer"),
		),
	);
	const finalEditorNodeId = finalEditorCoversOutline ? latestAcceptedEditor?.id : undefined;
	const reviewedFinalEditor = Boolean(
		finalEditorNodeId
		&& acceptedNodes.some((node) => node.kind === "reviewer" && node.dependsOn.includes(finalEditorNodeId)),
	);
	const allAdjudicated = nodes.length > 0 && nodes.every((node) => isAdjudicatedStatus(node.status));
	const policyReady = policyAllowsCompletion({
		mode: run.mode,
		policy,
		acceptedResearchLanes,
		acceptedSectionWriters,
		acceptedKinds,
		hasBrief: Boolean(run.researchBrief),
		hasOutline: Boolean(run.documentOutline),
		unresolvedGaps: gaps,
		unresolvedConflicts: conflicts,
		allAdjudicated,
	});
	const editorialChainReady = (!policy.gates.requireEditor || finalEditorCoversOutline)
		&& (!policy.gates.requireReviewer || (policy.gates.requireEditor ? reviewedFinalEditor : acceptedKinds.includes("reviewer")));
	const reviewerRelease = acceptedReviewerRelease(run);
	const readyToComplete = policyAllowsCompletion({
		mode: run.mode,
		policy,
		acceptedResearchLanes,
		acceptedSectionWriters,
		acceptedKinds,
		hasBrief: Boolean(run.researchBrief),
		hasOutline: Boolean(run.documentOutline),
		unresolvedGaps: gaps,
		unresolvedConflicts: conflicts,
		allAdjudicated,
		reviewerRelease,
	}) && editorialChainReady;
	const nextAction = ready > 0
		? "run_ready" as const
		: completedAwaitingDecision > 0
			? "evaluate_results" as const
			: failed > 0 || cancelled > 0
				? "resolve_failures" as const
				: running > 0 || waiting > 0
					? "wait_for_subagents" as const
				: readyToComplete
					? "complete" as const
					: "apply_plan" as const;
	return {
		totalNodes: nodes.length,
		ready,
		running,
		waiting,
		completedAwaitingDecision,
		accepted,
		rejected,
		superseded,
		failed,
		cancelled,
		exhausted,
		pending,
		gaps,
		conflicts,
		acceptedKinds,
		acceptedResearchLanes,
		acceptedSectionWriters,
		...(finalEditorNodeId ? { finalEditorNodeId } : {}),
		finalEditorCoversOutline,
		reviewedFinalEditor,
		...(reviewerRelease ? { reviewerRelease } : {}),
		readyToComplete,
		policy,
		nextAction,
	};
}
