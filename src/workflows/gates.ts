import { effectiveAcceptedNodes, isAdjudicatedStatus, acceptedReviewerRelease, finalAcceptedEditor, nodeTransitivelyDependsOn } from "./effective-nodes.ts";
import { policyAllowsCompletion, resolveWorkflowPolicy, type WorkflowPolicy } from "./policy.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "./retry-policy.ts";
import { normalizeWorkflowText } from "./text-normalize.ts";
import { outlineSectionWriterNodeIds } from "./section-ownership.ts";
import type { WorkflowNode, WorkflowNodeKind, WorkflowReviewerRelease, WorkflowRun } from "./types.ts";

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
	completionBlockers: string[];
	nextAction: "apply_plan" | "run_ready" | "wait_for_subagents" | "evaluate_results" | "resolve_failures" | "resolve_gates" | "complete";
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
	const outlineWriterIds = outlineSectionWriterNodeIds(run.documentOutline);
	const editorCoversWriter = (editor: WorkflowNode, writerId: string): boolean => {
		const visited = new Set<string>();
		let current = run.nodes[writerId];
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (nodeTransitivelyDependsOn(run, editor.id, current.id)) return true;
			if (current.status !== "superseded" || !current.supersededBy) break;
			current = run.nodes[current.supersededBy];
		}
		return false;
	};
	const editorCoversOutline = (editor: WorkflowNode): boolean => outlineWriterIds.size > 0
		&& [...outlineWriterIds].every((writerId) => editorCoversWriter(editor, writerId));
	const editorReviewed = (editor: WorkflowNode): boolean => acceptedNodes.some((node) =>
		node.kind === "reviewer" && nodeTransitivelyDependsOn(run, node.id, editor.id),
	);
	// The newest accepted Editor is the candidate final revision. Its complete
	// revision chain may cover Section Writers transitively, but that exact revision
	// still needs an accepted downstream review.
	const finalEditor = finalAcceptedEditor(run);
	const finalEditorCoversOutline = Boolean(finalEditor && editorCoversOutline(finalEditor));
	const finalEditorNodeId = finalEditorCoversOutline ? finalEditor?.id : undefined;
	const reviewedFinalEditor = Boolean(finalEditor && editorReviewed(finalEditor));
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
	const reviewerRelease = acceptedReviewerRelease(run);
	const editorialChainReady = (!policy.gates.requireEditor || finalEditorCoversOutline)
		&& (!policy.gates.requireReviewer || (policy.gates.requireEditor ? reviewedFinalEditor && reviewerRelease?.release === true : reviewerRelease?.release === true));
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
	const completionBlockers = [
		policy.gates.requireBrief && !run.researchBrief ? "research brief is missing" : undefined,
		policy.gates.requireOutline && !run.documentOutline ? "approved outline is missing" : undefined,
		acceptedResearchLanes < policy.gates.minAcceptedResearchLanes ? `accepted research lanes ${acceptedResearchLanes}/${policy.gates.minAcceptedResearchLanes}` : undefined,
		acceptedSectionWriters < policy.gates.minAcceptedSectionWriters ? `accepted Section Writers ${acceptedSectionWriters}/${policy.gates.minAcceptedSectionWriters}` : undefined,
		policy.gates.requireWriter && !acceptedKinds.includes("writer") ? "an accepted Writer is required by policy" : undefined,
		gaps > policy.gates.maxUnresolvedGaps && reviewerRelease?.gapsAccepted !== true ? `${gaps} unresolved evidence gap(s)` : undefined,
		conflicts > policy.gates.maxUnresolvedConflicts && reviewerRelease?.conflictsAccepted !== true ? `${conflicts} unresolved evidence conflict(s)` : undefined,
		!allAdjudicated ? `${nodes.filter((node) => !isAdjudicatedStatus(node.status)).length} node(s) are not adjudicated` : undefined,
		policy.gates.requireEditor && !finalEditorCoversOutline ? "no accepted final Editor covers every outline Section Writer" : undefined,
		policy.gates.requireReviewer && !reviewedFinalEditor ? "no accepted Reviewer reviewed the final Editor revision" : undefined,
		policy.gates.requireReviewer && reviewedFinalEditor && reviewerRelease?.release !== true ? "the final Reviewer has not approved document release" : undefined,
	].filter((value): value is string => Boolean(value));
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
					: nodes.length === 0
						? "apply_plan" as const
						: "resolve_gates" as const;
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
		completionBlockers,
		nextAction,
	};
}
