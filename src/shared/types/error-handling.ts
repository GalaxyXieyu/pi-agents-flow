/** Domain types split from shared/types.ts (compatible facade). */
import type { Usage, SubagentRunMode } from "./basic.ts";
import type { ArtifactPaths } from "./artifacts.ts";


export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface SubagentForegroundCompleteEvent {
	id: string;
	runId: string;
	source: "foreground";
	mode: SubagentRunMode;
	agent: string;
	success: boolean;
	summary: string;
	exitCode: number;
	state: string;
	timestamp: number;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	taskIndex: number;
	interrupted?: boolean;
	stopped?: boolean;
	processSignal?: string | null;
	timedOut?: boolean;
	turnBudgetExceeded?: boolean;
	structuredOutput?: unknown;
	model?: string;
	thinking?: string;
	launchContractDigest?: string;
	usage?: Usage;
	progressSummary?: { toolCount: number; tokens: number; durationMs: number };
	artifactPaths?: ArtifactPaths;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_STEERING_NOTICE_EVENT = "subagent:steering-notice";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
