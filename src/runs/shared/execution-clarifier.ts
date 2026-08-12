/**
 * UI-neutral ExecutionClarifier contract and headless adapter.
 *
 * Extracts BehaviorOverride/result/request types out of the chain-clarify TUI
 * so that subagent/chain execution core can clarify without statically
 * importing chain-clarify or pi-tui.  The default interactive adapter lives in
 * chain-clarify.ts (TUI file); the headless adapter here reuses A1b's
 * HeadlessDecisionProvider fail-closed contract.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agent-types.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import {
	executeHeadlessDecision,
	type HeadlessDecision,
	type HeadlessDecisionProvider,
	type HeadlessDecisionRequest,
} from "../../headless/decision-contract.ts";
import type { DecisionAuditSink } from "../../headless/decision-audit.ts";

export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;
	skills?: string[] | false;
}

export interface ExecutionClarificationRequest {
	mode: "single" | "parallel" | "chain";
	agentConfigs: AgentConfig[];
	templates: string[];
	originalTask: string;
	chainDir?: string;
	resolvedBehaviors: ResolvedStepBehavior[];
	availableModels: ModelInfo[];
	preferredProvider?: string;
	availableSkills: Array<{ name: string; source: string; description?: string }>;
	/** Platform context — the interactive adapter uses ctx.ui.custom; headless ignores it. */
	ctx: ExtensionContext;
	signal?: AbortSignal;
	/** Headless decision evidence digest (no secrets). */
	evidence?: unknown;
	/** Platform-owned forbidden capabilities that the clarifier must not expand. */
	forbiddenCapabilities?: readonly string[];
}

export type ExecutionClarificationResult =
	| { verdict: "approve"; templates: string[]; behaviorOverrides: (BehaviorOverride | undefined)[]; runInBackground?: boolean }
	| { verdict: "revise" | "reject" | "pause" | "request-more-evidence"; reason: string };

export interface ExecutionClarifier {
	decide(input: ExecutionClarificationRequest, signal?: AbortSignal): Promise<ExecutionClarificationResult>;
}

export interface HeadlessExecutionClarifierOptions {
	provider: HeadlessDecisionProvider;
	audit: DecisionAuditSink;
	policyVersion: string;
	approveThreshold: number;
	timeoutMs: number;
	traceId: (kind: HeadlessDecisionRequest["kind"]) => string;
	evidenceSufficient: (kind: HeadlessDecisionRequest["kind"], evidence: unknown) => boolean;
	policyAllowsApproval: (request: HeadlessDecisionRequest) => boolean;
	now?: () => Date;
}

/**
 * Creates a headless ExecutionClarifier that delegates every clarify request
 * to the A1b HeadlessDecisionProvider with full audit and fail-closed semantics.
 *
 * The headless adapter cannot widen capabilities: forbidden capabilities from
 * the request enter the provider constraint and the execution end re-intersects
 * them after the decision.  No default approve: timeout, provider failure,
 * malformed schema, low confidence, insufficient evidence, or policy conflict
 * all normalize to reject/pause/request-more-evidence.
 */
export function createHeadlessExecutionClarifier(options: HeadlessExecutionClarifierOptions): ExecutionClarifier {
	const decideWithProvider = async (
		input: ExecutionClarificationRequest,
		signal?: AbortSignal,
	): Promise<HeadlessDecision> => {
		const forbidden = input.forbiddenCapabilities ?? [];
		const request: HeadlessDecisionRequest = {
			kind: "clarify",
			evidence: input.evidence ?? {
				mode: input.mode,
				agents: input.agentConfigs.map((a) => a.name),
				templates: input.templates,
				originalTask: input.originalTask,
			},
			policyVersion: options.policyVersion,
			traceId: options.traceId("clarify"),
			forbiddenCapabilities: [...forbidden],
		};
		return executeHeadlessDecision({
			provider: options.provider,
			request,
			audit: options.audit,
			approveThreshold: options.approveThreshold,
			evidenceSufficient: options.evidenceSufficient("clarify", request.evidence),
			policyAllowsApproval: options.policyAllowsApproval(request),
			timeoutMs: options.timeoutMs,
			...(signal ? { signal } : {}),
			...(options.now ? { now: options.now } : {}),
		});
	};

	return {
		async decide(input, signal) {
			const decision = await decideWithProvider(input, signal);
			if (decision.verdict === "approve") {
				return {
					verdict: "approve",
					templates: input.templates,
					behaviorOverrides: input.agentConfigs.map(() => undefined),
				};
			}
			return { verdict: decision.verdict, reason: decision.reason };
		},
	};
}
