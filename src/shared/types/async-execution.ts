/** Domain types split from shared/types.ts (compatible facade). */
import type { AgentConfig } from "../../agents/agents.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelScopeConfig } from "../../runs/shared/model-scope.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../../runs/shared/capability-ceiling.ts";
import type { FSWatcher } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { OutputMode, ChainOutputMap, ChainCheckpointState, WorkflowGraphSnapshot, Usage, ToolBudgetState, TurnBudgetState, TokenUsage, ActivityState, SubagentResultStatus, SubagentOutputState, SubagentRunMode, ParallelHandoffReference, AgentContract, ExecutionProjection, ReviewProjection, EffectsProjection, SubagentLifecycleArtifactVersion, ProcessTerminal, SteeringStatus, CostSummary } from "./basic.ts";
import type { ChildWatchdogProgress, AgentProgress } from "./progress.ts";
import type { ModelAttempt, AcceptanceLedger, LaunchResolvedChildExtensions, RuntimeAcknowledgedChildExtensions, UsageBudgetState, SpawnBudgetGrant } from "./results.ts";
import type { ArtifactPaths, ArtifactDirPreference } from "./artifacts.ts";


export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
	agent: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "rejected";
	sessionFile?: string;
	transcriptPath?: string;
	transcriptError?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	watchdog?: ChildWatchdogProgress;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	processTerminal?: ProcessTerminal;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	children?: NestedRunSummary[];
}

export interface NestedRunSummary extends NestedRunAddress {
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	processTerminal?: ProcessTerminal;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: NestedStepSummary[];
	children?: NestedRunSummary[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	error?: string;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface AsyncStartedEvent {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	id?: string;
	asyncDir?: string;
	/** Parent-resolved launch directory, used as a trusted artifact root while this session is live. */
	cwd?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	/** Truncated first child task retained for backwards compatibility. */
	task?: string;
	/** Workflow-level caller task, falling back to the first child task. */
	goal?: string;
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	usageBudget?: UsageBudgetState;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: TurnBudgetState;
	nestedRoute?: NestedRouteInfo;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface AsyncStatus {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	runId: string;
	sessionId?: string;
	mode: SubagentRunMode;
	isNested?: boolean;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	usageBudget?: UsageBudgetState;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	pendingAppends?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	processTerminal?: ProcessTerminal;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	steps?: Array<{
		agent: string;
		/** Resolved launch context for this child step. */
		context?: "fresh" | "fork";
		/** Short caller-facing task/goal shown in fleet surfaces when available. */
		description?: string;
		phase?: string;
		label?: string;
		outputName?: string;
		structured?: boolean;
		checkpoint?: ChainCheckpointState;
		status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped" | "rejected";
		children?: NestedRunSummary[];
		sessionFile?: string;
		transcriptPath?: string;
		transcriptError?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		timedOut?: boolean;
		stopped?: boolean;
		turnBudget?: TurnBudgetState;
		turnBudgetExceeded?: boolean;
		wrapUpRequested?: boolean;
		toolBudget?: ToolBudgetState;
		toolBudgetBlocked?: boolean;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		thinking?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		totalCost?: CostSummary;
		steering?: SteeringStatus;
		error?: string;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
		acceptance?: AcceptanceLedger;
		agentContract?: AgentContract;
		launchContractDigest?: string;
		launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
		execution?: ExecutionProjection;
		review?: ReviewProjection;
		effects?: EffectsProjection;
		watchdog?: ChildWatchdogProgress;
		processTerminal?: ProcessTerminal;
		capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
		capabilityAudit?: SubagentCapabilityAudit;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	usageBudget?: UsageBudgetState;
	totalCost?: CostSummary;
	sessionFile?: string;
	outputs?: ChainOutputMap;
	parallelHandoff?: ParallelHandoffReference;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
	description?: string;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	/** Parent-resolved launch directory retained for trusted live artifact lookup. */
	cwd?: string;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
	/** Short caller-facing task/goal shown in fleet surfaces when available. */
	description?: string;
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	mode?: SubagentRunMode;
	/** Run-level context summary derived from step contexts. */
	context?: "fresh" | "fork" | "mixed";
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	checkpoint?: ChainCheckpointState;
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	usageBudget?: UsageBudgetState;
	sessionFile?: string;
	controlEventCursor?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	context?: "fresh" | "fork";
	sessionFile?: string;
	model?: string;
	thinking?: string;
	status: SubagentResultStatus;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	toolCount?: number;
	durationMs?: number;
	usage?: Usage;
	exitCode?: number;
	error?: string;
	finalOutput?: string;
	outputState?: SubagentOutputState;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputSaveError?: string;
	artifactPaths?: ArtifactPaths;
	transcriptPath?: string;
	transcriptError?: string;
	detachedReason?: string;
	acceptance?: AcceptanceLedger;
	agentContract?: AgentContract;
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	execution?: ExecutionProjection;
	review?: ReviewProjection;
	effects?: EffectsProjection;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	updatedAt?: number;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	/** Originating parent session. Detached exits can outlive the active session. */
	sessionId?: string;
	updatedAt: number;
	checkpoint?: ChainCheckpointState;
	children: ForegroundResumeChild[];
}

export interface ForegroundChildControl {
	index: number;
	agent: string;
	description?: string;
	startedAt: number;
	updatedAt: number;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: AgentProgress["recentTools"];
	recentOutput?: string[];
	turnCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	model?: string;
	thinking?: string;
	toolCount?: number;
	steerInboxDir?: string;
	steerCapabilityPath?: string;
	steerAckDir?: string;
	interrupt?: () => boolean;
	detach?: () => boolean;
}

export interface ForegroundRunControl {
	runId: string;
	/** Originating parent session; required for public fleet projection. */
	sessionId?: string;
	mode: SubagentRunMode;
	startedAt: number;
	updatedAt: number;
	/** Effective working directory used to resolve live transcript artifacts. */
	cwd?: string;
	currentAgent?: string;
	currentIndex?: number;
	/** Short caller-facing task/goal shown in fleet surfaces when available. */
	description?: string;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools?: AgentProgress["recentTools"];
	recentOutput?: string[];
	turnCount?: number;
	tokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	model?: string;
	thinking?: string;
	toolCount?: number;
	/** Short-lived root for per-child steering inboxes and acknowledgments. */
	steeringDir?: string;
	/** Independently tracked children for foreground parallel work and fleet inspection. */
	activeChildren?: Map<number, ForegroundChildControl>;
	/** Scheduling owners that may still launch another child. Removal is safe only at zero. */
	schedulingOwners?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
	interrupt?: () => boolean;
	detach?: () => boolean;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	/** Runtime-owned artifact resolution inputs used by Fleet transcript targeting. */
	artifactDirPreference?: ArtifactDirPreference;
	parentSessionFile?: string | null;
	/** Last valid parent session model observed for this session; used when continuation contexts omit ctx.model. */
	lastParentModel?: { provider: string; id: string };
	subagentInProgress?: boolean;
	subagentSpawns?: {
		sessionId: string | null;
		count: number;
		configuredLimit?: number | null;
		granted?: number;
		grantHistory?: SpawnBudgetGrant[];
	};
	asyncJobs: Map<string, AsyncJobState>;
	/** Current-session active and recent async runs for the native fleet inspector. */
	fleetJobs?: Map<string, AsyncJobState>;
	/** Suppress dynamic status widgets while the fleet overlay owns the viewport. */
	fleetInspectorOpen?: boolean;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, ForegroundRunControl>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** Temporary steering directories retained briefly for final acknowledgments. */
	foregroundSteeringCleanupDirs?: Map<string, string>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}
