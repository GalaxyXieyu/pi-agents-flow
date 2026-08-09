import type { WorkflowFailureClass } from "../runs/shared/model-fallback.ts";
import type { WorkflowPolicy } from "./policy.ts";
import type { WorkflowLanguage } from "./language.ts";

export type WorkflowMode = "general" | "deep-research";

export type CodingStage = "plan" | "build" | "verify" | "full";

export interface CodingWorkflowContract {
	stage: CodingStage;
	completionNodeId: string;
	completionPort: "result";
	approvalGateNodeId?: string;
	preApprovalAgents: string[];
}

export type WorkflowRunStatus = "active" | "paused" | "completed" | "stopped" | "failed";

export type WorkflowNodeKind = "research" | "verification" | "outline" | "section-writer" | "writer" | "editor" | "reviewer" | "custom";

export type WorkflowNodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "waiting"
	| "completed"
	| "accepted"
	| "superseded"
	| "rejected"
	| "failed"
	| "cancelled";

export type WorkflowJsonValue = null | boolean | number | string | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };

export type WorkflowArtifactClassification = "public" | "internal" | "sensitive" | "secret";

export interface WorkflowArtifactDescriptor {
	version: 1;
	artifactId: string;
	sha256: string;
	mediaType: string;
	bytes: number;
	encoding: "utf-8" | "binary";
	classification: WorkflowArtifactClassification;
	storage: {
		backend: "local";
		key: string;
		materializedPath: string;
	};
	createdBy: { nodeId: string; attemptId: string; port: string };
}

export interface WorkflowOutputPort {
	mediaType: string;
	description: string;
	storage: "auto" | "inline" | "artifact";
	required: boolean;
	maxInlineBytes?: number;
	classification: WorkflowArtifactClassification;
	schema?: Record<string, unknown>;
}

export interface WorkflowInputSource {
	nodeId: string;
	port: string;
	/** Optional JSON Pointer applied after loading the selected source port. */
	select?: string;
}

export interface WorkflowInputBinding {
	name: string;
	from: WorkflowInputSource[];
	purpose: string;
	delivery?: "auto" | "manifest" | "summary" | "inline" | "reference";
	merge?: "list" | "map-by-node" | "concat-text" | "first" | "error";
	required?: boolean;
	maxInlineBytes?: number;
}

export interface WorkflowContextBudget {
	maxInlineBytes?: number;
	maxPackBytes?: number;
	maxEstimatedTokens?: number;
	/** Highest artifact classification this node may receive. Defaults to internal. */
	clearance?: WorkflowArtifactClassification;
}

export interface WorkflowDataContract {
	version: 1;
	profile: "generic" | "research" | "writer" | "reviewer";
	inputs: WorkflowInputBinding[];
	outputs: Record<string, WorkflowOutputPort>;
	context?: WorkflowContextBudget;
	annotations?: Record<string, WorkflowJsonValue>;
	/** Namespaced, declarative metadata. Unknown extensions are persisted but never executed. */
	extensions?: Record<string, WorkflowJsonValue>;
}

export type WorkflowResolvedOutput =
	| {
		kind: "inline";
		mediaType: string;
		bytes: number;
		classification: WorkflowArtifactClassification;
		value: WorkflowJsonValue;
	}
	| {
		kind: "artifact";
		artifact: WorkflowArtifactDescriptor;
	};

export interface EphemeralAgentSpec {
	id: string;
	baseAgent: string;
	role: string;
	objective: string;
	instructions: string;
	context: "fresh" | "fork";
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	skills?: string[];
	/**
	 * Tools granted to this node on top of the base Agent's allowlist. Entries
	 * containing `/` are MCP direct-tool selectors (`server` or `server/tool`);
	 * others are builtin tool names. The capability ceiling still applies, so a
	 * node can never exceed it.
	 */
	extraTools?: string[];
	/** Tools revoked for this node even though the base Agent declares them. */
	denyTools?: string[];
	timeoutMs?: number;
	turnBudget?: { maxTurns: number; graceTurns?: number };
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
}

export interface WorkflowFinding {
	claim: string;
	evidence: Array<{
		title?: string;
		url?: string;
		artifactPath?: string;
		quote?: string;
		kind?: "primary" | "secondary" | "community";
		publishedAt?: string;
		retrievedAt?: string;
	}>;
	confidence: "high" | "medium" | "low";
}

export interface WorkflowSearchTrace {
	queries: string[];
	fetchedUrls: string[];
	droppedSources: Array<{ url: string; reason: string }>;
}

export interface WorkflowOutputSubmission {
	kind: "value" | "file";
	value?: WorkflowJsonValue;
	path?: string;
	sha256?: string;
}

export interface WorkflowResult {
	version: 1;
	summary: {
		text: string;
		covers: string[];
		omissions: string[];
		confidence: "high" | "medium" | "low";
	};
	outputs: Record<string, WorkflowOutputSubmission>;
	diagnostics: {
		gaps: Array<{ question: string; reason: string }>;
		conflicts: Array<{ statement: string; alternatives: string[]; evidence: string[] }>;
		warnings: string[];
	};
	recommendations: string[];
	evidence?: {
		findings: WorkflowFinding[];
		search?: WorkflowSearchTrace;
	};
	extensions?: Record<string, WorkflowJsonValue>;
}

export interface ResearchBrief {
	version: 0;
	audience: string;
	purpose: string;
	scope: string;
	depth: "overview" | "standard" | "deep" | "expert";
	deliverable: "research-report" | "technical-whitepaper" | "decision-memo";
	targetWords: { min: number; max: number };
	requiredTopics: string[];
	excludedTopics: string[];
	constraints: string[];
	assumptions: string[];
	clarification: "confirmed" | "inferred";
}

export interface WorkflowClarificationOption {
	label: string;
	description?: string;
}

export interface WorkflowClarificationQuestion {
	id: string;
	prompt: string;
	options: WorkflowClarificationOption[];
	multiple: boolean;
}

export interface WorkflowClarificationAnswer {
	id: string;
	prompt: string;
	answer: string;
	selections?: string[];
	wasCustom?: boolean;
}

export interface WorkflowClarificationRound {
	version: 0;
	answers: WorkflowClarificationAnswer[];
}

export interface DocumentOutlineSection {
	id: string;
	title: string;
	objective: string;
	questions: string[];
	evidenceRequirements: string[];
	targetWords: number;
	writerNodeId: string;
}

export interface DocumentOutline {
	version: 0;
	title: string;
	thesis: string;
	approval: "user" | "supervisor";
	sections: DocumentOutlineSection[];
}

export interface WorkflowTaskPlan {
	id: string;
	label: string;
	parentId?: string;
	order: number;
}

export interface WorkflowWorkUnitPlan {
	id: string;
	taskId: string;
	kind: WorkflowNodeKind;
	label: string;
	order: number;
	dependsOn: string[];
	agentSpec: EphemeralAgentSpec;
	dataContract: WorkflowDataContract;
	/**
	 * Optional id of a failed/cancelled node this work unit is meant to replace.
	 * When this work unit is accepted, the replaced node is automatically superseded,
	 * so a supervisor declares replacement intent once, at creation, instead of
	 * remembering a separate supersede call afterwards.
	 */
	replaces?: string;
}

export interface WorkflowFailure {
	failureClass: WorkflowFailureClass;
	retryable: boolean;
	suggestedAction: string;
	pauseWorkflow?: boolean;
}

export interface WorkflowAttempt {
	attemptId: string;
	requestId: string;
	number: number;
	startedAt: number;
	completedAt?: number;
	status: "running" | "waiting" | "completed" | "failed" | "cancelled";
	error?: string;
	/** Durable failure disposition used by retry guidance and workflow recovery. */
	failure?: WorkflowFailure;
	result?: WorkflowResult;
	childRunId?: string;
	launchContractDigest?: string;
	structuredOutputPath?: string;
	metadataPath?: string;
	/** Persisted outputs retained even when the child attempt fails. */
	artifactPaths?: string[];
	/** Original terminal error when a valid result was salvaged. */
	recoveredFromError?: string;
	/** Immutable full envelope for V1 nodes; result is only a bounded event preview. */
	resultArtifact?: WorkflowArtifactDescriptor;
	outputs?: Record<string, WorkflowResolvedOutput>;
	model?: string;
	/** When set, a detached/waiting node that exceeds this deadline is failed to avoid an infinite wait. */
	waitDeadline?: number;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
		toolCalls: number;
		durationMs: number;
	};
}

export interface WorkflowNode extends WorkflowWorkUnitPlan {
	status: WorkflowNodeStatus;
	attempts: WorkflowAttempt[];
	result?: WorkflowResult;
	resultArtifact?: WorkflowArtifactDescriptor;
	outputs?: Record<string, WorkflowResolvedOutput>;
	decision?: string;
	/** Accepted replacement that makes this historical result ineffective. */
	supersededBy?: string;
	/**
	 * Per-node attempt ceiling that overrides the run-level maximum. Set when a
	 * failed/cancelled node is reopened to grant it additional attempts in place.
	 */
	maxAttempts?: number;
}

export interface WorkflowReviewerRelease {
	/** Overall: the reviewer approves release of the final document. */
	release: boolean;
	/** Reviewer accepts the remaining unresolved evidence gaps. */
	gapsAccepted?: boolean;
	/** Reviewer accepts the remaining unresolved conflicts. */
	conflictsAccepted?: boolean;
	/** Reviewer accepts the final-citation coverage shortfall. */
	citationShortfallAccepted?: boolean;
	/** Reviewer accepts the final-document length shortfall. */
	lengthShortfallAccepted?: boolean;
	rationale?: string;
}

export interface WorkflowDecision {
	id: string;
	kind: "accepted_uncertainty" | "gap_resolution" | "conflict_resolution";
	target: string;
	rationale: string;
	at?: number;
}

export interface WorkflowContinuationState {
	signature: string;
	attempts: number;
	lastRequestedAt: number;
	trigger: "agent_settled" | "session_recovery";
}

export interface WorkflowRun {
	version: 1;
	id: string;
	mode: WorkflowMode;
	goal: string;
	/** Resolved output/display language. Legacy runs derive it from goal. */
	language?: WorkflowLanguage;
	cwd: string;
	sessionId: string;
	branch: string;
	status: WorkflowRunStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
	tasks: Record<string, WorkflowTaskPlan>;
	/** Work units remain a DAG map for scheduling; each belongs to one human-level task. */
	nodes: Record<string, WorkflowNode>;
	decisions: WorkflowDecision[];
	/** Optional run-scoped quality/gate/evidence policy. Defaults are derived from mode. */
	policy?: WorkflowPolicy;
	/** Trusted Coding preset contract persisted by the runtime-owned /coding start path. */
	codingContract?: CodingWorkflowContract;
	/** Persisted node-attempt ceiling resolved when this workflow started. Legacy fixtures may omit it. */
	maxNodeAttempts?: number;
	/**
	 * Hard cumulative cap on work units that may ever be added via apply_plan.
	 * Prevents unbounded repair/adjudication node growth from burning budget.
	 */
	maxNodes?: number;
	/** Persisted Deep Research user-intent contract. */
	researchBrief?: ResearchBrief;
	/** Durable answers collected through the native Pi human-in-the-loop dialogs. */
	clarifications?: WorkflowClarificationRound[];
	/** Persisted long-form document architecture and section ownership. */
	documentOutline?: DocumentOutline;
	continuation?: WorkflowContinuationState;
	/** Human-readable reason recorded when the workflow was paused. */
	pauseReason?: string;
	/** Node ids added after stop; only these may run during an explicit repair restart. */
	repairPlanNodeIdsAfterStop?: string[];
	appliedEventIds: string[];
}

interface WorkflowEventBase {
	id: string;
	at: number;
}

export type WorkflowEvent =
	| (WorkflowEventBase & {
		type: "workflow.started";
		runId: string;
		mode: WorkflowMode;
		goal: string;
		language?: WorkflowLanguage;
		cwd: string;
		sessionId: string;
		branch: string;
		policy?: WorkflowPolicy;
		codingContract?: CodingWorkflowContract;
		maxNodeAttempts?: number;
		maxNodes?: number;
	})
	| (WorkflowEventBase & { type: "workflow.plan_applied"; tasks: WorkflowTaskPlan[]; workUnits: WorkflowWorkUnitPlan[] })
	| (WorkflowEventBase & { type: "workflow.clarification_recorded"; round: WorkflowClarificationRound })
	| (WorkflowEventBase & { type: "workflow.brief_set"; brief: ResearchBrief })
	| (WorkflowEventBase & { type: "workflow.outline_set"; outline: DocumentOutline })
	| (WorkflowEventBase & {
		type: "node.started";
		nodeId: string;
		attempt: Omit<WorkflowAttempt, "status" | "completedAt" | "error" | "result">;
	})
	| (WorkflowEventBase & {
		type: "node.waiting";
		nodeId: string;
		attemptId: string;
		reason: string;
		childRunId: string;
		launchContractDigest?: string;
		structuredOutputPath?: string;
		metadataPath?: string;
		model?: string;
		usage?: WorkflowAttempt["usage"];
		/** Absolute epoch-ms deadline after which this waiting node is failed if still unresolved. */
		waitDeadline?: number;
	})
	| (WorkflowEventBase & {
		type: "node.completed";
		nodeId: string;
		attemptId: string;
		result: WorkflowResult;
		resultArtifact?: WorkflowArtifactDescriptor;
		outputs?: Record<string, WorkflowResolvedOutput>;
		childRunId?: string;
		launchContractDigest?: string;
		model?: string;
		usage?: WorkflowAttempt["usage"];
		structuredOutputPath?: string;
		metadataPath?: string;
		/**
		 * Set when the child reported a transport or provider failure but had already
		 * written a valid envelope. Records the original error so a recovered node is
		 * never silently indistinguishable from a clean completion.
		 */
		recoveredFromError?: string;
		artifactPaths?: string[];
	})
	| (WorkflowEventBase & {
		type: "node.failed";
		nodeId: string;
		attemptId: string;
		error: string;
		failure?: WorkflowFailure;
		childRunId?: string;
		launchContractDigest?: string;
		model?: string;
		usage?: WorkflowAttempt["usage"];
		structuredOutputPath?: string;
		metadataPath?: string;
		artifactPaths?: string[];
	})
	| (WorkflowEventBase & {
		type: "node.cancelled";
		nodeId: string;
		attemptId: string;
		error: string;
		childRunId?: string;
		launchContractDigest?: string;
		model?: string;
		usage?: WorkflowAttempt["usage"];
		structuredOutputPath?: string;
		metadataPath?: string;
		artifactPaths?: string[];
	})
	| (WorkflowEventBase & { type: "node.accepted"; nodeId: string; decision: string })
	| (WorkflowEventBase & { type: "node.superseded"; nodeId: string; replacementNodeId: string; decision: string })
	| (WorkflowEventBase & { type: "node.reopened"; nodeId: string; additionalAttempts?: number; decision: string })
	| (WorkflowEventBase & { type: "node.rejected"; nodeId: string; decision: string })
	| (WorkflowEventBase & { type: "workflow.decision_recorded"; decision: Omit<WorkflowDecision, "at"> })
	| (WorkflowEventBase & {
		type: "workflow.continuation_requested";
		signature: string;
		attempt: number;
		trigger: WorkflowContinuationState["trigger"];
	})
	| (WorkflowEventBase & { type: "workflow.status_changed"; status: WorkflowRunStatus; reason?: string });
