import * as fs from "node:fs";

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
import { DEFAULT_TURN_BUDGET_GRACE_TURNS, DEFAULT_WORKFLOW_CHILD_TURN_BUDGET } from "../runs/shared/turn-budget.ts";
import { CODING_PREAPPROVAL_READONLY_ANNOTATION } from "./coding-preset.ts";
import { workflowResultSchema, parseWorkflowResult, WORKFLOW_RESULT_SUBMISSION_GUIDE } from "./result-contract.ts";
import type { AvailableModelInfo, ParentModel } from "../runs/shared/model-fallback.ts";
import type { WorkflowAttempt, WorkflowDataContract, WorkflowNode, WorkflowRun } from "./types.ts";

export interface WorkflowDelegationEvents {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

export type WorkflowPreflightResult =
	| {
		ok: true;
		agent: string;
		model?: string;
		modelCandidates?: string[];
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

export interface WorkflowDelegationRuntimeContext {
	parentModel?: ParentModel;
	availableModels?: AvailableModelInfo[];
}

export interface WorkflowDelegationAdapter {
	run(run: WorkflowRun, node: WorkflowNode, attempt: WorkflowAttempt, signal?: AbortSignal, runtime?: WorkflowDelegationRuntimeContext): Promise<WorkflowDelegationRunResult>;
}

interface CreateWorkflowDelegationAdapterOptions {
	events: WorkflowDelegationEvents;
	preflight?: WorkflowPreflight;
	responseTimeoutMs?: number;
	/** Workflow-only fixed fallback chain; does not mutate base Agent config. */
	fallbackModels?: string[];
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

/**
 * Generate a per-node output contract guide from the data contract.
 * Injected into the task prompt so the agent sees its exact output ports,
 * media types, and required fields before it starts working.
 */
function buildOutputContractGuide(contract: WorkflowDataContract, formatError?: string): string {
	const ports = Object.entries(contract.outputs);
	if (ports.length === 0) return "";
	const lines = [
		"## Output contract — you MUST submit via structured_output",
	];
	if (formatError) {
		lines.push(
			"",
			`PREVIOUS SUBMISSION FAILED FORMAT VALIDATION: ${formatError}`,
			"",
			"Do not repeat the invalid envelope. Keep the task content, but repair the submission shape and re-submit only through structured_output.",
			"Use this exact outer shape: {\"value\":{\"version\":1,\"summary\":{...},\"outputs\":{...},\"diagnostics\":{...},\"recommendations\":[],\"evidence\":{...}}}",
		);
	}
	for (const [name, port] of ports) {
		const req = port.required ? "REQUIRED" : "optional";
		const storageNote = port.storage === "artifact"
			? `, write large content to the output slot file first, then submit outputs.${name} as kind:file with that exact path; keep small results inline`
			: ", keep this port inline in structured_output.value unless it exceeds the inline budget";
		const typeHint = port.mediaType.toLowerCase().startsWith("text/") ? " (value must be a string)" : "";
		lines.push(`- **${name}** [${req}] ${port.mediaType}${typeHint}${storageNote}${port.description ? ` — ${port.description}` : ""}`);
	}
	if (contract.profile === "research" || contract.profile === "writer") {
		lines.push("", "evidence.findings array is REQUIRED for this profile.");
	}
	if (contract.profile === "reviewer") {
		lines.push("", "Reviewer control contract: include top-level review:{verdict:'pass'|'fail'} inside WorkflowResult. A pass MUST also include top-level extensions:{release:{release:true,rationale:'non-empty',...}}; a fail MUST omit extensions.release. Do not put review or release in an output file, summary text, or outside the outer tool value.");
	}
	lines.push("", "Do NOT return prose or raw text outside of structured_output. Every output port must appear in the outputs object.");
	return lines.join("\n");
}

function taskFor(node: WorkflowNode, formatError?: string): string {
	const contractGuide = buildOutputContractGuide(node.dataContract, formatError);
	return [
		`Role: ${node.agentSpec.role}`,
		`Objective: ${node.agentSpec.objective}`,
		`Instructions: ${node.agentSpec.instructions}`,
		...(contractGuide ? [contractGuide] : []),
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
	formatError?: string,
	turnBudget = node.agentSpec.turnBudget,
	delegationRequestId = attempt.requestId,
): SubagentDelegationRequest {
	const resultSchema = workflowResultSchema(node.dataContract);
	return {
		version: SUBAGENT_DELEGATION_PROTOCOL_VERSION,
		requestId: delegationRequestId,
		ownerRunId: run.id,
		nodeId: node.id,
		agent: resolved.agent,
		task: taskFor(node, formatError),
		context: node.agentSpec.context,
		cwd: run.cwd,
		...(resolved.model ?? node.agentSpec.model ? { model: resolved.model ?? node.agentSpec.model } : {}),
		...(resolved.modelCandidates && resolved.modelCandidates.length > 1 ? { fallbackModels: resolved.modelCandidates.slice(1) } : {}),
		...(resolved.thinking ?? node.agentSpec.thinking ? { thinking: resolved.thinking ?? node.agentSpec.thinking } : {}),
		...(node.agentSpec.timeoutMs !== undefined ? { timeoutMs: node.agentSpec.timeoutMs } : {}),
		...(turnBudget ? { turnBudget } : {}),
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
		modelCandidates: [...result.contract.modelCandidates],
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
	const MAX_FORMAT_STEER_ATTEMPTS = 2;
	return {
		async run(run, node, attempt, signal, runtime) {
			const resultSchema = workflowResultSchema(node.dataContract);
			// Bound every bounded workflow child so its context stays under the provider's
			// stable streaming range. Unbounded executors accumulate 400k+ tokens and the
			// taqu provider drops the stream before finish_reason. Explicit node budgets win;
			// otherwise inject a conservative default.
			const turnBudget = node.agentSpec.turnBudget
				? {
					maxTurns: node.agentSpec.turnBudget.maxTurns,
					graceTurns: node.agentSpec.turnBudget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS,
				}
				: { maxTurns: DEFAULT_WORKFLOW_CHILD_TURN_BUDGET, graceTurns: DEFAULT_TURN_BUDGET_GRACE_TURNS };

			function buildTask(formatErr?: string): string {
				return taskFor(node, formatErr);
			}

			let formatError: string | undefined;
			let resolvedPreflight: Extract<WorkflowPreflightResult, { ok: true }> | undefined;
			for (let steer = 0; steer <= MAX_FORMAT_STEER_ATTEMPTS; steer++) {
				const delegationRequestId = steer === 0 ? attempt.requestId : `${attempt.requestId}:format-${steer}`;
				const task = buildTask(formatError);
				if (!resolvedPreflight) {
					const preflightResult = await preflight({
						agent: node.agentSpec.baseAgent,
						cwd: run.cwd,
						task,
						context: node.agentSpec.context,
						...(node.agentSpec.model ? { model: node.agentSpec.model } : {}),
						...(options.fallbackModels?.length ? { fallbackModels: [...options.fallbackModels] } : {}),
						...(runtime?.parentModel ? { parentModel: runtime.parentModel } : {}),
						...(runtime?.availableModels ? { availableModels: runtime.availableModels } : {}),
						...(runtime?.parentModel?.provider ? { preferredProvider: runtime.parentModel.provider } : {}),
						...(node.agentSpec.thinking ? { thinking: node.agentSpec.thinking } : {}),
						...(node.agentSpec.skills ? { skill: node.agentSpec.skills } : {}),
						...(node.agentSpec.extraTools?.length ? { extraTools: [...node.agentSpec.extraTools] } : {}),
						...(node.agentSpec.denyTools?.length ? { denyTools: [...node.agentSpec.denyTools] } : {}),
						outputSchema: resultSchema,
						...(turnBudget ? { turnBudget } : {}),
						artifacts: true,
						runId: delegationRequestId,
					});
					if (preflightResult.ok === false) return { ok: false, stage: "preflight", error: preflightResult.error };
					resolvedPreflight = preflightResult;
				}
				const preflightResult = resolvedPreflight;
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
				const request = buildWorkflowDelegationRequest(run, node, attempt, preflightResult, formatError, turnBudget, delegationRequestId);
				let response: SubagentDelegationResponse;
				try {
					response = await waitForResponse(options.events, request, signal, responseTimeoutMs);
				} catch (error) {
					return { ok: false, stage: "transport", error: error instanceof Error ? error.message : String(error) };
				}

				// Auto-steer on format validation failure: validate structured output
				// before returning to the controller. If the format is wrong, inject the
				// specific error into the task and re-dispatch (up to MAX_FORMAT_STEER_ATTEMPTS).
				if (
					steer < MAX_FORMAT_STEER_ATTEMPTS
					&& response.status === "completed"
					&& response.result?.kind === "structured"
				) {
					try {
						parseWorkflowResult(response.result.value, node.dataContract);
						// Format is valid — return the response to the controller.
						return {
							ok: true,
							response,
							...(preflightResult.launchContractDigest ? { launchContractDigest: preflightResult.launchContractDigest } : {}),
						};
					} catch (parseErr) {
						formatError = parseErr instanceof Error ? parseErr.message : String(parseErr);
						// Loop back: re-dispatch with the format error injected into the task.
						continue;
					}
				}

				// Non-completed response or format validation not applicable — return as-is.
				return {
					ok: true,
					response,
					...(preflightResult.launchContractDigest ? { launchContractDigest: preflightResult.launchContractDigest } : {}),
				};
			}
			// Should not reach here (loop always returns), but satisfy the type checker.
			return { ok: false, stage: "transport", error: "Format steer loop exited without a response." };
		},
	};
}
