/**
 * Pure workflow controller helpers and public controller types.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SubagentForegroundCompleteEvent } from "../shared/types.ts";
import type { WorkflowDelegationAdapter } from "./delegation-adapter.ts";
import type { WorkflowBinding } from "./branch-binding.ts";
import type { CodingStage, CodingWorkflowContract } from "./coding-preset.ts";
import type { WorkflowEvaluation } from "./gates.ts";
import { buildWorkflowRepairGuidance, formatWorkflowRepairGuidance, type WorkflowRepairGuidance } from "./guidance.ts";
import type { WorkflowLanguageMode } from "./language.ts";
import type { WorkflowPolicy } from "./policy.ts";
import type { WorkflowQualityReport } from "./quality.ts";
import { resolveWorkflowMaxNodeAttempts } from "./retry-policy.ts";
import type { WorkflowTodoAdapterResult } from "./todo-adapter.ts";
import type { WorkflowTodoProjection } from "./todo-projection.ts";
import type { WorkflowOutlineReviewResult } from "../tui/workflow-outline-review.ts";
import type {
	DocumentOutline,
	ResearchBrief,
	WorkflowClarificationQuestion,
	WorkflowClarificationRound,
	WorkflowContinuationState,
	WorkflowMode,
	WorkflowResult,
	WorkflowRun,
	WorkflowTaskPlan,
	WorkflowWorkUnitPlan,
} from "./types.ts";

export const WORKFLOW_BINDING_ENTRY_TYPE = "pi-agents-flow-workflow-binding";

export type WorkflowActionParams =
	| { action: "start"; goal: string; mode?: WorkflowMode; language?: WorkflowLanguageMode; policy?: Partial<WorkflowPolicy> | WorkflowPolicy; codingStage?: CodingStage }
	| { action: "clarify"; runId?: string; questions: WorkflowClarificationQuestion[] }
	| { action: "set_brief"; runId?: string; brief: ResearchBrief }
	| { action: "set_outline"; runId?: string; outline: DocumentOutline }
	| { action: "apply_plan"; runId?: string; tasks: WorkflowTaskPlan[]; workUnits: WorkflowWorkUnitPlan[] }
	| { action: "run_ready"; runId?: string; concurrency?: number; nodeId?: string }
	| { action: "evaluate"; runId?: string }
	| { action: "quality"; runId?: string }
	| { action: "get_result"; runId?: string; nodeId: string }
	| { action: "accept"; runId?: string; nodeId: string; decision: string }
	| { action: "reject"; runId?: string; nodeId: string; decision: string }
	| { action: "supersede"; runId?: string; nodeId: string; replacementNodeId: string; decision: string }
	| { action: "reopen"; runId?: string; nodeId: string; additionalAttempts?: number; decision: string }
	| { action: "record_decision"; runId?: string; decisionKind: "accepted_uncertainty" | "gap_resolution" | "conflict_resolution"; target: string; rationale: string }
	| { action: "complete"; runId?: string; nodeId: string; port: string; digest: string }
	| { action: "status"; runId?: string }
	| { action: "pause"; runId?: string; reason?: string }
	| { action: "resume"; runId?: string }
	| { action: "stop"; runId?: string }
	| { action: "cancel_node"; runId?: string; nodeId: string }
	| { action: "update_node"; runId?: string; nodeId: string; label?: string; objective?: string; instructions?: string; acceptance?: string };

export interface WorkflowControllerDetails {
	run: WorkflowRun;
	evaluation?: WorkflowEvaluation;
	finalPath?: string;
	todoProjection?: WorkflowTodoProjection;
	qualityReport?: WorkflowQualityReport;
	qualityReportPath?: string;
	repairGuidance?: WorkflowRepairGuidance;
	clarification?: { cancelled: boolean; round?: WorkflowClarificationRound };
	outlineReview?: WorkflowOutlineReviewResult;
}

export interface WorkflowControllerResult {
	text: string;
	details: WorkflowControllerDetails;
}

export interface WorkflowController {
	execute(params: WorkflowActionParams, ctx: ExtensionContext, signal?: AbortSignal, onProgress?: (run: WorkflowRun) => void): Promise<WorkflowControllerResult>;
	current(ctx: ExtensionContext): WorkflowRun | undefined;
	recover(ctx: ExtensionContext): WorkflowRun | undefined;
	handleForegroundCompletion(ctx: ExtensionContext, event: unknown): WorkflowRun | undefined;
	requestContinuation(ctx: ExtensionContext, trigger: WorkflowContinuationState["trigger"]): WorkflowContinuationDecision | undefined;
}

export interface WorkflowContinuationDecision {
	run: WorkflowRun;
	evaluation: WorkflowEvaluation;
	attempt: number;
	suppressed: boolean;
	prompt?: string;
}

export interface CreateWorkflowControllerOptions {
	adapter: WorkflowDelegationAdapter;
	appendEntry: (customType: string, data?: unknown) => void;
	createRunId?: () => string;
	createEventId?: () => string;
	now?: () => number;
	resolveBranch?: (cwd: string) => string;
	rootDir?: (cwd: string) => string;
	hasTool?: (name: string) => boolean;
	cancelWaitingChild?: (childRunId: string) => boolean;
	applyTodoProjection?: (projection: WorkflowTodoProjection, sessionId: string) => WorkflowTodoAdapterResult;
	onRunChanged?: (run: WorkflowRun) => void;
	defaultLanguage?: WorkflowLanguageMode;
	/**
	 * Ceiling on workflow children running at once.
	 *
	 * Resolved from `workflowConcurrency` in the extension config when omitted, so
	 * the limit is user-configurable without every caller having to thread it.
	 */
	maxConcurrency?: number;
	/** Persisted per-node attempt ceiling for newly created workflows. */
	maxNodeAttempts?: number;
}

export function bindingFrom(value: unknown): WorkflowBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const binding = value as Partial<WorkflowBinding>;
	if (
		binding.version !== 0
		|| typeof binding.runId !== "string"
		|| typeof binding.revision !== "number"
		|| typeof binding.sessionId !== "string"
		|| typeof binding.cwd !== "string"
		|| typeof binding.branch !== "string"
	) return undefined;
	return binding as WorkflowBinding;
}

export function latestBinding(ctx: ExtensionContext): WorkflowBinding | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== WORKFLOW_BINDING_ENTRY_TYPE) continue;
		const binding = bindingFrom(entry.data);
		if (binding) return binding;
	}
	return undefined;
}

export function defaultBranch(cwd: string): string {
	try {
		const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		if (branch && branch !== "HEAD") return branch;
		const commit = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		if (/^[a-f0-9]{40,64}$/i.test(commit)) return `detached:${commit}`;
		throw new Error("Git returned an invalid HEAD identity.");
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		if (typeof stderr === "string" && /not a git repository/i.test(stderr)) return "no-git";
		throw new Error(`Unable to resolve workflow branch identity: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function bounded(value: string, max = 1_200): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n[truncated; use get_result for the complete envelope]`;
}

export function parseForegroundCompletion(value: unknown): SubagentForegroundCompleteEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Partial<SubagentForegroundCompleteEvent>;
	if (
		event.source !== "foreground"
		|| typeof event.id !== "string"
		|| typeof event.runId !== "string"
		|| typeof event.success !== "boolean"
		|| typeof event.summary !== "string"
		|| typeof event.exitCode !== "number"
		|| typeof event.timestamp !== "number"
	) return undefined;
	return event as SubagentForegroundCompleteEvent;
}

export function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export function guidanceDetails(run: WorkflowRun, evaluation: WorkflowEvaluation): { repairGuidance: WorkflowRepairGuidance; guidanceText: string } {
	const repairGuidance = buildWorkflowRepairGuidance(run, evaluation);
	return { repairGuidance, guidanceText: formatWorkflowRepairGuidance(repairGuidance) };
}

export function codingWorkflowContract(run: WorkflowRun): CodingWorkflowContract | undefined {
	return run.codingContract;
}

export function effectiveWorkflowNodeId(run: WorkflowRun, nodeId: string): string {
	const visited = new Set<string>();
	let node = run.nodes[nodeId];
	while (node?.status === "superseded" && node.supersededBy && !visited.has(node.id)) {
		visited.add(node.id);
		node = run.nodes[node.supersededBy];
	}
	return node?.id ?? nodeId;
}

export function dependsOnGate(
	nodeId: string,
	gateNodeId: string,
	nodes: Record<string, WorkflowWorkUnitPlan | WorkflowRun["nodes"][string]>,
	visited = new Set<string>(),
): boolean {
	if (nodeId === gateNodeId) return true;
	if (visited.has(nodeId)) return false;
	visited.add(nodeId);
	return (nodes[nodeId]?.dependsOn ?? []).some((dependency) => dependsOnGate(dependency, gateNodeId, nodes, visited));
}

export function statusText(run: WorkflowRun, evaluation: WorkflowEvaluation, includeResults = false): string {
	const lines = [
		`Workflow ${run.id} (${run.mode}) is ${run.status}.`,
		...(run.mode === "deep-research" ? [`Clarification rounds: ${run.clarifications?.length ?? 0}; research brief: ${run.researchBrief ? "ready" : "missing"}; outline: ${run.documentOutline ? `${run.documentOutline.sections.length} sections` : "missing"}.`] : []),
		`Nodes: ${evaluation.accepted} accepted, ${evaluation.superseded} superseded, ${evaluation.rejected} rejected, ${evaluation.completedAwaitingDecision} awaiting decision, ${evaluation.ready} ready, ${evaluation.running} running, ${evaluation.waiting} waiting, ${evaluation.pending} pending, ${evaluation.failed} failed, ${evaluation.cancelled} cancelled, ${evaluation.exhausted} attempt-exhausted.`,
		`Node attempt ceiling: ${resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts)}.`,
		`Gaps: ${evaluation.gaps}; conflicts: ${evaluation.conflicts}; next action: ${evaluation.nextAction}.`,
		...(evaluation.completionBlockers.length > 0 ? [`Completion blockers: ${evaluation.completionBlockers.join("; ")}.`] : []),
	];
	if (Object.keys(run.nodes).length > 0) {
		lines.push("", "Node status:");
		for (const node of Object.values(run.nodes)) {
			const attempt = node.attempts.at(-1);
			const execution = [attempt?.childRunId ? `child ${attempt.childRunId}` : undefined, attempt?.model, attempt?.usage ? `${attempt.usage.input + attempt.usage.output} tokens` : undefined].filter(Boolean).join(", ");
			lines.push(`- ${node.id} [${node.status}] ${node.kind}: ${node.label}${execution ? ` (${execution})` : ""}`);
			if (!includeResults || !node.result) continue;
			lines.push(`  Summary: ${bounded(node.result.summary.text).replace(/\n/g, "\n  ")}`);
			for (const finding of (node.result.evidence?.findings ?? []).slice(0, 10)) {
				const evidence = finding.evidence.map((entry) => entry.url ?? entry.artifactPath ?? entry.title).filter(Boolean).join(", ");
				lines.push(`  Claim (${finding.confidence}): ${finding.claim}${evidence ? ` [${evidence}]` : " [no evidence reference]"}`);
			}
			for (const gap of node.result.diagnostics.gaps) lines.push(`  Gap: ${gap.question} — ${gap.reason}`);
			for (const conflict of node.result.diagnostics.conflicts) lines.push(`  Conflict: ${conflict.statement} — ${conflict.alternatives.join(" | ")}`);
		}
	}
	return lines.join("\n");
}

