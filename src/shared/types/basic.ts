/** Domain types split from shared/types.ts (compatible facade). */


export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type AcceptanceRole = "read-only" | "writer";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
	text: string;
	structured?: unknown;
	agent: string;
	stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed" | "paused" | "stopped" | "detached" | "rejected";

export interface WorkflowGraphNode {
	id: string;
	kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent" | "checkpoint";
	agent?: string;
	phase?: string;
	label: string;
	status: WorkflowNodeStatus;
	flatIndex?: number;
	stepIndex?: number;
	children?: WorkflowGraphNode[];
	dynamic?: {
		sourceOutput: string;
		sourcePath: string;
		itemName: string;
		maxItems?: number;
		collectAs?: string;
	};
	itemKey?: string;
	outputName?: string;
	structured?: boolean;
	acceptanceStatus?: AcceptanceLedgerStatus;
	error?: string;
	checkpoint?: ChainCheckpointState;
}

export interface ChainCheckpointState {
	name: string;
	message?: string;
	status: "pending" | "approved" | "rejected";
	stepIndex: number;
	approvedAt?: number;
	rejectedAt?: number;
}

export interface WorkflowGraphSnapshot {
	runId: string;
	mode: "chain" | "parallel" | "single";
	phases: Array<{ title: string; nodeIds: string[] }>;
	nodes: WorkflowGraphNode[];
	currentNodeId?: string;
}

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TurnBudgetConfig {
	maxTurns: number;
	graceTurns?: number;
}

export interface ResolvedTurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface ResolvedToolBudget {
	soft?: number;
	hard: number;
	block: string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
	outcome: ToolBudgetOutcome;
	toolCount: number;
	softReachedAt?: number;
	hardReachedAt?: number;
	blockedTool?: string;
}

export type TurnBudgetOutcome = "within-budget" | "wrap-up-requested" | "termination-deferred" | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
	outcome: TurnBudgetOutcome;
	turnCount: number;
	wrapUpRequestedAtTurn?: number;
	terminationDeferredAtTurn?: number;
	exceededAtTurn?: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

/**
 * Smart completion batching for async-completion notifications. Successful
 * sibling completions are held briefly so they arrive as one grouped message;
 * failure and attention signals bypass grouping and always fire immediately.
 */
export interface CompletionBatchConfig {
	enabled?: boolean;
	/** Idle window after each arrival; resets on every new item. */
	debounceMs?: number;
	/** Hard cap measured from the first item in a group. */
	maxWaitMs?: number;
	/** Shorter idle window for straggler groups. */
	stragglerDebounceMs?: number;
	/** Shorter hard cap for straggler groups. */
	stragglerMaxWaitMs?: number;
	/** Arrivals within this window after an emit join a straggler group. */
	stragglerWindowMs?: number;
}

export interface WaitToolConfigObject {
	enabled?: boolean;
}

export type WaitToolConfig = boolean | WaitToolConfigObject;

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	nestedRunId?: string;
	nestingPath?: NestedRunAddress["path"];
	message: string;
	reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "supervisor_request" | "time_threshold" | "turn_threshold" | "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "stopped" | "detached";
export type SubagentOutputState = "present" | "absent" | "unknown";
export type SubagentRunMode = "single" | "parallel" | "chain";

export interface ParallelHandoffPatch {
	path: string;
	branch: string;
	changed: boolean;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	error?: string;
}

export interface ParallelHandoffChild {
	index: number;
	taskIndex: number;
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	outputPath?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	sessionPath?: string;
	patch: ParallelHandoffPatch;
}

export interface ParallelHandoffCleanupTask {
	index: number;
	path: string;
	branch: string;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	errors?: string[];
}

export interface ParallelHandoffGroup {
	stepIndex: number;
	baseCommit: string;
	repoRoot: string;
	children: ParallelHandoffChild[];
	cleanup: {
		state: "complete" | "partial";
		tasks: ParallelHandoffCleanupTask[];
		pruned: boolean;
		errors?: string[];
	};
}

export interface ParallelHandoffManifest {
	version: 1;
	runId: string;
	mode: "parallel" | "chain";
	source: "foreground" | "async";
	cwd: string;
	createdAt: number;
	updatedAt: number;
	groups: ParallelHandoffGroup[];
}

export interface ParallelHandoffReference {
	version: 1;
	path: string;
	groupCount: number;
	childCount: number;
	changedPatches: number;
	cleanupState: "complete" | "partial";
}

export interface AgentContract {
	version: 1;
}

export type ChainGateLayer = "execution" | "acceptance";

export type ExecutionProjectionStatus = "completed" | "failed" | "paused" | "stopped" | "detached";

export interface ExecutionProjection {
	status: ExecutionProjectionStatus;
	success: boolean;
	exitCode: number;
	error?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	detached?: boolean;
}

export interface ReviewProjection {
	status: "not-requested" | "review-required" | "reviewed" | "blockers";
	findings?: AcceptanceReviewResult["findings"];
}

export interface FileMutationEffect {
	status: "not-requested" | "not-applicable" | "observed" | "missing";
	expected: boolean;
	attempted: boolean;
	message?: string;
}

export interface EffectsProjection {
	fileMutation?: FileMutationEffect;
}

export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 3;
export type SubagentLifecycleArtifactVersion = typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;

export type ProcessTerminalState = "pending" | "observed" | "unknown" | "not-started";
export type ProcessTerminalReason =
	| "observer-unavailable"
	| "runner-candidate-missing"
	| "runner-instance-mismatch"
	| "writer-close-unverified"
	| "canonical-session-unavailable"
	| "canonical-session-lease-active"
	| "canonical-session-release-unverified"
	| "proof-write-failed"
	| "stale-repair";

export interface RunnerProcessInstanceExit {
	processInstanceId: string;
	kind: "runner";
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export interface PiWriterProcessInstanceExit {
	processInstanceId: string;
	kind: "pi-writer";
	attempt: number;
	closeObservedAt: number;
	exitCode: number | null;
	signal: string | null;
}

export type ProcessInstanceExit = RunnerProcessInstanceExit | PiWriterProcessInstanceExit;

export interface CanonicalSessionTerminal {
	canonicalSessionId: string;
	leaseDisposition: "released" | "not-held";
	freeAtObservation: true;
	canonicalSessionLeaseReleased?: true;
}

interface ProcessTerminalBase {
	version: 1;
	runId: string;
	childIndex?: number;
	runnerProcessInstanceId: string;
	resumeDisposition?: "resumable" | "non-resumable" | "unavailable";
}

export type ProcessTerminal =
	| (ProcessTerminalBase & { state: "pending" | "not-started" })
	| (ProcessTerminalBase & {
		state: "observed";
		observedAt: number;
		instances: ProcessInstanceExit[];
		canonicalSession?: CanonicalSessionTerminal;
	})
	| (ProcessTerminalBase & {
		state: "unknown";
		reason: ProcessTerminalReason;
		diagnostic?: string;
	});

export type SteeringActionState = "delivered" | "scheduled" | "pending" | "partial" | "recovered" | "failed";
export type SteeringTargetState = "scheduled" | "routed" | "delivered" | "late" | "failed" | "recovered";

export interface SteeringTargetStatus {
	index: number;
	state: SteeringTargetState;
	routedAt?: number;
	deliveredAt?: number;
	lateDeliveredAt?: number;
	failedAt?: number;
	recoveredAt?: number;
	reason?: string;
	replacementRunId?: string;
}

export interface SteeringRequestStatus {
	id: string;
	requestedAt: number;
	source?: string;
	messagePreview: string;
	targets: SteeringTargetStatus[];
}

export interface SteeringStatus {
	requested: number;
	scheduled: number;
	pending: number;
	delivered: number;
	failed: number;
	recovered: number;
	lastRequestedAt?: number;
	lastDeliveredAt?: number;
	recent: SteeringRequestStatus[];
}

export interface SteerActionTarget {
	index: number;
	state: SteeringTargetState;
	deliveredAt?: number;
	lateDeliveredAt?: number;
	reason?: string;
	replacementRunId?: string;
}

export interface SteerActionResult {
	requestId: string;
	state: SteeringActionState;
	sourceRunId: string;
	replacementRunId?: string;
	targets: SteerActionTarget[];
}

export interface SteeringNotice {
	type: "subagent.steering.notice";
	ts: number;
	runId: string;
	requestId: string;
	state: "failed" | "partial" | "recovered";
	message: string;
	currentSessionId?: string;
}

export interface SteeringRecoveryDescriptor {
	version: 1;
	launchContractDigest?: string;
	sourceRunId: string;
	agentContract?: AgentContract;
	agent: string;
	invocation?: "both" | "model" | "user" | "disabled";
	sessionFile?: string;
	cwd: string;
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	skillPath?: string[];
	agentFilePath?: string;
	completionGuard?: boolean;
	memory?: { scope: "project" | "user"; path: string };
	outputPath?: string;
	outputMode: "inline" | "file-only";
	structuredOutputSchema?: JsonSchemaObject;
	acceptance?: AcceptanceInput;
	controlConfig?: ResolvedControlConfig;
	absoluteDeadlineAt?: number;
	initialTurnBudget?: ResolvedTurnBudget;
	initialToolBudget?: ResolvedToolBudget;
	maxSubagentDepth: number;
	maxOutput?: MaxOutputConfig;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	share: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
}

export type PublicNestedStepSummary = Pick<
	NestedStepSummary,
	"agent" | "status" | "sessionFile" | "transcriptPath" | "transcriptError" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "startedAt" | "endedAt" | "error" | "timedOut" | "stopped"
> & {
	children?: PublicNestedRunSummary[];
};

export type CostSummary = {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
};

export type PublicNestedRunSummary = Pick<
	NestedRunSummary,
	"id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path" | "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget" | "ownerState" | "mode" | "state" | "agent" | "agents" | "currentStep" | "chainStepCount" | "parallelGroups" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "totalTokens" | "totalCost" | "startedAt" | "endedAt" | "lastUpdate" | "error" | "timeoutMs" | "deadlineAt" | "timedOut" | "stopped" | "turnBudget" | "turnBudgetExceeded" | "wrapUpRequested"
> & {
	steps?: PublicNestedStepSummary[];
	children?: PublicNestedRunSummary[];
};

export interface SubagentResultIntercomChild {
	agent: string;
	/** Process/lifecycle status. It does not establish semantic task completion. */
	status: SubagentResultStatus;
	/** Whether the child produced substantive output before its process ended. */
	outputState?: SubagentOutputState;
	summary: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
	children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	parallelHandoff?: ParallelHandoffReference;
}
