import type { FleetItem } from "../tui/fleet.ts";
import type { WorkflowNode, WorkflowRun, WorkflowTaskPlan } from "../workflows/types.ts";

export type ActivityPerspective = "work" | "agents";

export type ActivityState =
	| "running"
	| "waiting"
	| "ready"
	| "pending"
	| "completed"
	| "accepted"
	| "failed"
	| "paused"
	| "cancelled"
	| "superseded";

export interface ActivityEvent {
	key: string;
	text: string;
	state: ActivityState;
}

export interface ActivityUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	toolCalls?: number;
}

export interface ActivityArtifact {
	path: string;
	kind: "evidence" | "run";
	label: string;
	cwd?: string;
}

export interface AgentExecutionActivity {
	key: string;
	agent: string;
	state: ActivityState;
	startedAt: number;
	durationMs?: number;
	usage?: ActivityUsage;
	artifacts: ActivityArtifact[];
	activity?: string;
	recent: ActivityEvent[];
	inspectKey?: string;
	workUnitId?: string;
	taskId?: string;
	taskPath?: string;
	attempt: number;
	error?: string;
	role?: string;
	objective?: string;
	context?: "fresh" | "fork";
	skills?: string[];
	extraTools?: string[];
	denyTools?: string[];
	fleetItem?: FleetItem;
}

export interface WorkUnitActivity {
	id: string;
	taskId: string;
	label: string;
	order: number;
	state: ActivityState;
	dependsOn: string[];
	attempts: number;
	durationMs?: number;
	usage?: ActivityUsage;
	artifacts: ActivityArtifact[];
	executions: AgentExecutionActivity[];
	reason?: string;
	node: WorkflowNode;
}

export interface TaskActivity {
	id: string;
	label: string;
	parentId?: string;
	order: number;
	state: ActivityState;
	workUnits: WorkUnitActivity[];
	children: TaskActivity[];
	completed: number;
	total: number;
	durationMs?: number;
	usage?: ActivityUsage;
	artifacts: ActivityArtifact[];
	plan: WorkflowTaskPlan;
}

export interface ActivitySnapshot {
	version: 1;
	language: "zh" | "en";
	workflow?: {
		runId: string;
		goal: string;
		status: WorkflowRun["status"];
		tasks: TaskActivity[];
	};
	executions: AgentExecutionActivity[];
	independent: AgentExecutionActivity[];
	updatedAt: number;
}

export type ActivitySelection =
	| { kind: "task"; key: string; task: TaskActivity }
	| { kind: "work-unit"; key: string; task: TaskActivity; workUnit: WorkUnitActivity }
	| { kind: "execution"; key: string; execution: AgentExecutionActivity };
