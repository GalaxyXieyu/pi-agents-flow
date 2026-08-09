export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 2 as const;

// Reuse the established extension-to-extension event family instead of adding
// a second transport.
export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

export interface SubagentDelegationTurnBudget {
	maxTurns: number;
	graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export type SubagentDelegationJsonSchemaObject = Record<string, unknown>;

export type SubagentDelegationThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SubagentDelegationResultRequest =
	| { kind: "text" }
	| { kind: "structured"; schema: SubagentDelegationJsonSchemaObject };

export interface SubagentDelegationRequest {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	cwd: string;
	model?: string;
	/** Ordered per-launch fallbacks resolved by workflow preflight. */
	fallbackModels?: string[];
	thinking?: SubagentDelegationThinking;
	timeoutMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | boolean;
	/** Per-launch role-specific grants layered onto runtime defaults and the base Agent declaration. */
	extraTools?: string[];
	/** Per-launch policy revocations applied after defaults and additions resolve. */
	denyTools?: string[];
	artifacts?: boolean;
	result: SubagentDelegationResultRequest;
}

export interface SubagentDelegationStarted {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId: string;
	nodeId: string;
}

export interface SubagentDelegationUpdate extends SubagentDelegationStarted {
	runId?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	recentOutputLines?: string[];
	recentTools?: Array<{ tool: string; args: string }>;
	model?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export type SubagentDelegationStatus =
	| "completed"
	| "detached"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "structured_output_failed"
	| "acceptance_failed"
	| "invalid_request"
	| "unavailable_context"
	| "duplicate_node";

export type SubagentDelegationValue =
	| { kind: "text"; text: string }
	| { kind: "structured"; value: unknown };

export interface SubagentDelegationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export interface SubagentDelegationTerminalResponse extends SubagentDelegationStarted {
	status: Exclude<SubagentDelegationStatus, "invalid_request">;
	error?: string;
	runId?: string;
	agent?: string;
	model?: string;
	thinking?: string;
	exitCode?: number;
	launchContractDigest?: string;
	structuredOutputPath?: string;
	metadataPath?: string;
	result?: SubagentDelegationValue;
	usage?: SubagentDelegationUsage;
}

/** A malformed request can only be correlated by the valid identity fields it supplied. */
export interface SubagentDelegationInvalidResponse {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	ownerRunId?: string;
	nodeId?: string;
	status: "invalid_request";
	error?: string;
}

export type SubagentDelegationResponse = SubagentDelegationTerminalResponse | SubagentDelegationInvalidResponse;

export interface SubagentDelegationCancel extends SubagentDelegationStarted {}
