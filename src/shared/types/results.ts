/** Domain types split from shared/types.ts (compatible facade). */
import type { Message } from "@earendil-works/pi-ai";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../../runs/shared/capability-ceiling.ts";
import type { OutputMode, ChainOutputMap, ChainCheckpointState, WorkflowGraphSnapshot, SavedOutputReference, Usage, ResolvedTurnBudget, ResolvedToolBudget, ToolBudgetState, TurnBudgetState, ControlEvent, SubagentOutputState, SubagentRunMode, ParallelHandoffReference, AgentContract, ExecutionProjection, ReviewProjection, EffectsProjection, ProcessTerminal, SteerActionResult, CostSummary } from "./basic.ts";
import type { ChildWatchdogProgress, AgentProgress, ToolCallSummary } from "./progress.ts";


export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export type AcceptanceLevel = "auto" | "none" | "attested" | "checked" | "verified";

export type AcceptanceEvidenceKind =
	| "changed-files"
	| "tests-added"
	| "commands-run"
	| "validation-output"
	| "residual-risks"
	| "no-staged-files"
	| "diff-summary"
	| "review-findings"
	| "manual-notes";

export interface AcceptanceGate {
	id: string;
	must: string;
	evidence?: AcceptanceEvidenceKind[];
	severity?: "required" | "recommended";
}

export interface AcceptanceVerifyCommand {
	id: string;
	command: string;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	allowFailure?: boolean;
}

export interface AcceptanceReviewGate {
	agent?: string;
	focus?: string;
	required?: boolean;
}

export interface AcceptanceConfig {
	level?: AcceptanceLevel;
	criteria?: Array<string | AcceptanceGate>;
	evidence?: AcceptanceEvidenceKind[];
	verify?: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules?: string[];
	reason?: string;
}

/** Bare "none" is not accepted: use { level: "none", reason: "..." }; false remains a deprecated shorthand. */
export type AcceptanceInput = Exclude<AcceptanceLevel, "none"> | false | AcceptanceConfig;

export interface ResolvedAcceptanceGate extends AcceptanceGate {
	id: string;
	must: string;
	evidence: AcceptanceEvidenceKind[];
	severity: "required" | "recommended";
}

export interface ResolvedAcceptanceConfig {
	level: Exclude<AcceptanceLevel, "auto">;
	explicit: boolean;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	evidence: AcceptanceEvidenceKind[];
	verify: AcceptanceVerifyCommand[];
	review?: AcceptanceReviewGate | false;
	stopRules: string[];
	reason?: string;
}

export interface AcceptanceReport {
	criteriaSatisfied?: Array<{
		id?: string;
		status: "satisfied" | "not-satisfied" | "not-applicable";
		evidence: string;
	}>;
	changedFiles?: string[];
	testsAddedOrUpdated?: string[];
	commandsRun?: Array<{
		command: string;
		result: "passed" | "failed" | "not-run";
		summary: string;
	}>;
	validationOutput?: string[];
	residualRisks?: string[];
	noStagedFiles?: boolean;
	diffSummary?: string;
	reviewFindings?: string[];
	manualNotes?: string;
	notes?: string;
}

export type AcceptanceRuntimeCheckStatus = "passed" | "failed" | "not-applicable";

export interface AcceptanceRuntimeCheck {
	id: string;
	status: AcceptanceRuntimeCheckStatus;
	message: string;
}

export interface AcceptanceVerifyResult {
	id: string;
	command: string;
	cwd?: string;
	exitCode: number | null;
	status: "passed" | "failed" | "timed-out" | "allowed-failure";
	stdout?: string;
	stderr?: string;
	durationMs: number;
}

export interface AcceptanceReviewResult {
	status: "review-required" | "reviewed" | "blockers";
	findings: Array<{
		severity: "blocker" | "non-blocking";
		file?: string;
		issue: string;
		rationale: string;
	}>;
}

export type AcceptanceEvidenceStatus =
	| "pending"
	| "not-required"
	| "claimed"
	| "attested"
	| "checked"
	| "verified"
	| "rejected";

export type AcceptanceLedgerStatus =
	| AcceptanceEvidenceStatus
	| "review-required"
	| "reviewed"
	| "accepted";

export interface AcceptanceLedger {
	status: AcceptanceLedgerStatus;
	evidenceStatus: AcceptanceEvidenceStatus;
	explicit: boolean;
	effectiveAcceptance: ResolvedAcceptanceConfig;
	inferredReason: string[];
	criteria: ResolvedAcceptanceGate[];
	childReport?: AcceptanceReport;
	childReportParseError?: string;
	runtimeChecks: AcceptanceRuntimeCheck[];
	verifyRuns: AcceptanceVerifyResult[];
	reviewResult?: AcceptanceReviewResult;
	parentDecision?: {
		status: "accepted" | "rejected";
		at: string;
		reason?: string;
	};
}

export interface ProtocolOutputLimit {
	code: "protocol_output_limit";
	stream: "stdout" | "stderr";
	limitBytes: number;
	observedBytes: number;
	diagnosticPrefix: string;
	diagnosticTail: string;
}

export interface LaunchResolvedChildExtensions {
	version: 1;
	/** This is parent-resolved launch intent, not child-runtime acknowledgement that extensions loaded. */
	source: "launch-resolved";
	disableAmbientExtensions: boolean;
	runtime: string[];
	configured: string[];
	effective: string[];
	omitted: {
		runtime: number;
		configured: number;
		effective: number;
	};
}

export interface RuntimeAcknowledgedChildExtensions {
	version: 1;
	/** Best-effort child-runtime registration acknowledgement, not extension health. */
	source: "child-runtime";
	ids: string[];
	omitted: number;
}

export interface UsageBudgetLimitConfig {
	soft?: number;
	hard: number;
}

export interface UsageBudgetConfig {
	tokens?: UsageBudgetLimitConfig;
	costUsd?: UsageBudgetLimitConfig;
}

export interface UsageBudgetMetricState extends UsageBudgetLimitConfig {
	used: number;
	outcome: "within-budget" | "soft-exceeded" | "hard-exceeded";
}

export interface UsageBudgetState {
	version: 1;
	/** Enforced from usage reported by completed or streaming child runs; no reservation estimates. */
	source: "reported";
	tokens?: UsageBudgetMetricState;
	costUsd?: UsageBudgetMetricState;
	exhausted: boolean;
	reason?: "tokens" | "costUsd";
}

export interface SingleResult {
	/**
	 * Stable child identity within the foreground run. Pair with Details.runId for
	 * cross-run correlation. This is assigned in launch order, remains stable across
	 * partial progress snapshots and the final result, and is independent of the
	 * result row's array position.
	 */
	index: number;
	agent: string;
	task: string;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	exitCode: number;
	processSignal?: string | null;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	/** Effective thinking level used by this foreground child, when known. */
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	protocolError?: ProtocolOutputLimit;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	/** Provenance-aware state for substantive child output, excluding synthetic lifecycle messages. */
	outputState?: SubagentOutputState;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	/** Best-effort metadata persistence failure; execution and receipt publication continue. */
	metadataSaveError?: string;
	structuredOutput?: unknown;
	structuredOutputFailed?: boolean;
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
	transcriptPath?: string;
	transcriptError?: string;
	children?: NestedRunSummary[];
	watchdog?: ChildWatchdogProgress;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
}

export interface SpawnBudgetGrant {
	sessionId: string;
	amount: number;
	grantedAt: number;
	previousLimit: number;
	limit: number;
}

export interface SpawnBudgetSnapshot {
	used: number;
	configuredLimit: number | null;
	granted: number;
	limit: number | null;
	remaining: number | null;
	grantRemaining: number | null;
	grantHistory: SpawnBudgetGrant[];
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	/** Run-level context summary. "mixed" when children resolved to different modes. */
	context?: "fresh" | "fork" | "mixed";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	steering?: SteerActionResult;
	asyncId?: string;
	asyncDir?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetState;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
	workflowGraph?: WorkflowGraphSnapshot;
	checkpoint?: ChainCheckpointState;
	outputs?: ChainOutputMap;
	// Aggregated child usage across all agents in the run
	totalChildUsage?: Usage;
	// Aggregated cost across all agents in the run
	totalCost?: CostSummary;
	spawnBudget?: SpawnBudgetSnapshot;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	parallelHandoff?: ParallelHandoffReference;
	lifecycleStatus?: {
		processTerminal?: ProcessTerminal;
	};
	launchContractDigest?: string;
	launchResolvedExtensions?: LaunchResolvedChildExtensions;
	runtimeAcknowledgedExtensions?: RuntimeAcknowledgedChildExtensions;
	/** Original launch contract whose persisted session is being revived. */
	sourceLaunchContractDigest?: string;
}
