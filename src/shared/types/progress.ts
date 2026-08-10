/** Domain types split from shared/types.ts (compatible facade). */
import type { ActivityState } from "./basic.ts";


export interface ChildWatchdogProgress {
	phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed";
	seq: number;
	lastUpdate: number;
	followUpPending: boolean;
	reason?: string;
	timedOut?: boolean;
}

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	/** Resolved launch model/effort and split usage for public live projections. */
	model?: string;
	thinking?: string;
	inputTokens?: number;
	outputTokens?: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
	watchdog?: ChildWatchdogProgress;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}
