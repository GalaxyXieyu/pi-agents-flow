import {
	SUBAGENT_DELEGATION_CANCEL_EVENT,
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_PROTOCOL_VERSION,
	type SubagentDelegationCancel,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationThinking,
} from "../api/delegation.ts";
import {
	resolveSubagentLaunchContract,
	type SubagentLaunchContractInput,
} from "../api/preflight.ts";
import { DEFAULT_TURN_BUDGET_GRACE_TURNS } from "../runs/shared/turn-budget.ts";
import { CODING_PREAPPROVAL_READONLY_ANNOTATION } from "./coding-preset.ts";
import { workflowResultSchema, WORKFLOW_RESULT_SUBMISSION_GUIDE } from "./result-contract.ts";
import type { WorkflowAttempt, WorkflowNode, WorkflowRun } from "./types.ts";

export interface WorkflowDelegationEvents {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

export type WorkflowPreflightResult =
	| {
		ok: true;
		agent: string;
		model?: string;
		thinking?: SubagentDelegationThinking;
		launchContractDigest?: string;
		effectiveTools?: string[];
		effectiveMcpTools?: string[];
	}
	| { ok: false; error: string };

export type WorkflowPreflight = (input: SubagentLaunchContractInput) => Promise<WorkflowPreflightResult>;

export type WorkflowDelegationRunResult =
	| { ok: true; response: SubagentDelegationResponse; launchContractDigest?: string }
	| { ok: false; stage: "preflight" | "transport"; error: string };

export interface WorkflowDelegationAdapter {
	run(run: WorkflowRun, node: WorkflowNode, attempt: WorkflowAttempt, signal?: AbortSignal): Promise<WorkflowDelegationRunResult>;
}

interface CreateWorkflowDelegationAdapterOptions {
	events: WorkflowDelegationEvents;
	preflight?: WorkflowPreflight;
	responseTimeoutMs?: number;
}

const thinkingLevels = new Set<SubagentDelegationThinking>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function taskFor(node: WorkflowNode): string {
	return [
		`Role: ${node.agentSpec.role}`,
		`Objective: ${node.agentSpec.objective}`,
		`Instructions: ${node.agentSpec.instructions}`,
		WORKFLOW_RESULT_SUBMISSION_GUIDE,
	].join("\n\n");
}

function v2Thinking(value: string | undefined): SubagentDelegationThinking | undefined {
	if (!value || !thinkingLevels.has(value as SubagentDelegationThinking)) return undefined;
	return value as SubagentDelegationThinking;
}

export function buildWorkflowDelegationRequest(
	run: WorkflowRun,
	node: WorkflowNode,
	attempt: WorkflowAttempt,
	resolved: Extract<WorkflowPreflightResult, { ok: true }>,
): SubagentDelegationRequest {
	const resultSchema = workflowResultSchema(node.dataContract);
	return {
		version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
		requestId: attempt.requestId,
		ownerRunId: run.id,
		nodeId: node.id,
		agent: resolved.agent,
		task: taskFor(node),
		context: node.agentSpec.context,
		cwd: run.cwd,
		...(resolved.model ?? node.agentSpec.model ? { model: resolved.model ?? node.agentSpec.model } : {}),
		...(resolved.thinking ?? node.agentSpec.thinking ? { thinking: resolved.thinking ?? node.agentSpec.thinking } : {}),
		...(node.agentSpec.timeoutMs !== undefined ? { timeoutMs: node.agentSpec.timeoutMs } : {}),
		...(node.agentSpec.turnBudget ? { turnBudget: node.agentSpec.turnBudget } : {}),
		...(node.agentSpec.toolBudget ? { toolBudget: node.agentSpec.toolBudget } : {}),
		...(node.agentSpec.skills && node.agentSpec.skills.length > 0 ? { skill: node.agentSpec.skills } : {}),
		...(node.agentSpec.extraTools?.length ? { extraTools: [...node.agentSpec.extraTools] } : {}),
		...(node.agentSpec.denyTools?.length ? { denyTools: [...node.agentSpec.denyTools] } : {}),
		artifacts: true,
		result: { kind: "structured", schema: resultSchema },
	};
}

async function defaultPreflight(input: SubagentLaunchContractInput): Promise<WorkflowPreflightResult> {
	const result = await resolveSubagentLaunchContract(input);
	if (result.ok === false) return { ok: false, error: result.message };
	return {
		ok: true,
		agent: result.contract.agent.name,
		...(result.contract.model ? { model: result.contract.model } : {}),
		...(v2Thinking(result.contract.thinking) ? { thinking: v2Thinking(result.contract.thinking) } : {}),
		launchContractDigest: result.contract.launchContractDigest,
		effectiveTools: [...result.contract.tools.effectiveAllowlist],
		effectiveMcpTools: [...result.contract.tools.effectiveMcpTools],
	};
}

function matchesResponse(data: unknown, request: SubagentDelegationRequest): data is SubagentDelegationResponse {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const response = data as Partial<SubagentDelegationResponse>;
	if (response.version !== SUBAGENT_DELEGATION_PROTOCOL_VERSION || response.requestId !== request.requestId) return false;
	if (response.status === "invalid_request") {
		return (response.ownerRunId === undefined || response.ownerRunId === request.ownerRunId)
			&& (response.nodeId === undefined || response.nodeId === request.nodeId);
	}
	return response.ownerRunId === request.ownerRunId && response.nodeId === request.nodeId;
}

function waitForResponse(
	events: WorkflowDelegationEvents,
	request: SubagentDelegationRequest,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<SubagentDelegationResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let cancelEmitted = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => {
			if (settled || cancelEmitted) return;
			cancelEmitted = true;
			const cancel: SubagentDelegationCancel = {
				version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
				requestId: request.requestId,
				ownerRunId: request.ownerRunId,
				nodeId: request.nodeId,
			};
			events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, cancel);
		};
		const unsubscribe = events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (data) => {
			if (matchesResponse(data, request)) finish(() => resolve(data));
		});
		const timer = setTimeout(
			() => finish(() => reject(new Error(`Timed out waiting for delegated response to '${request.nodeId}'.`))),
			timeoutMs,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
		if (signal?.aborted) onAbort();
	});
}

export function createWorkflowDelegationAdapter(
	options: CreateWorkflowDelegationAdapterOptions,
): WorkflowDelegationAdapter {
	const preflight = options.preflight ?? defaultPreflight;
	const responseTimeoutMs = options.responseTimeoutMs ?? 30 * 60 * 1_000;
	return {
		async run(run, node, attempt, signal) {
			const resultSchema = workflowResultSchema(node.dataContract);
			const turnBudget = node.agentSpec.turnBudget
				? {
					maxTurns: node.agentSpec.turnBudget.maxTurns,
					graceTurns: node.agentSpec.turnBudget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS,
				}
				: undefined;
			const preflightResult = await preflight({
				agent: node.agentSpec.baseAgent,
				cwd: run.cwd,
				task: taskFor(node),
				context: node.agentSpec.context,
				...(node.agentSpec.model ? { model: node.agentSpec.model } : {}),
				...(node.agentSpec.thinking ? { thinking: node.agentSpec.thinking } : {}),
				...(node.agentSpec.skills ? { skill: node.agentSpec.skills } : {}),
				...(node.agentSpec.extraTools?.length ? { extraTools: [...node.agentSpec.extraTools] } : {}),
				...(node.agentSpec.denyTools?.length ? { denyTools: [...node.agentSpec.denyTools] } : {}),
				outputSchema: resultSchema,
				...(turnBudget ? { turnBudget } : {}),
				artifacts: true,
				runId: attempt.requestId,
			});
			if (preflightResult.ok === false) return { ok: false, stage: "preflight", error: preflightResult.error };
			if (node.dataContract.annotations?.[CODING_PREAPPROVAL_READONLY_ANNOTATION]) {
				const allowedReadOnlyTools = new Set(["read", "grep", "find", "ls", "contact_supervisor", "intercom", "structured_output"]);
				const disallowedTools = (preflightResult.effectiveTools ?? []).filter((tool) => !allowedReadOnlyTools.has(tool));
				const mcpTools = preflightResult.effectiveMcpTools ?? [];
				if (preflightResult.effectiveTools === undefined || preflightResult.effectiveMcpTools === undefined) {
					return { ok: false, stage: "preflight", error: `Coding pre-approval node '${node.id}' could not prove its effective read-only capability set.` };
				}
				if (disallowedTools.length > 0 || mcpTools.length > 0) {
					return {
						ok: false,
						stage: "preflight",
						error: `Coding pre-approval node '${node.id}' has non-read-only effective tools: ${[...disallowedTools, ...mcpTools].join(", ")}.`,
					};
				}
			}
			const request = buildWorkflowDelegationRequest(run, node, attempt, preflightResult);
			try {
				const response = await waitForResponse(options.events, request, signal, responseTimeoutMs);
				return {
					ok: true,
					response,
					...(preflightResult.launchContractDigest ? { launchContractDigest: preflightResult.launchContractDigest } : {}),
				};
			} catch (error) {
				return { ok: false, stage: "transport", error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
