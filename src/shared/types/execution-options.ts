/** Domain types split from shared/types.ts (compatible facade). */
import type { AgentConfig } from "../../agents/agents.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelScopeConfig } from "../../runs/shared/model-scope.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../../runs/shared/capability-ceiling.ts";
import type { MaxOutputConfig, OutputMode, JsonSchemaObject, TurnBudgetConfig, ResolvedTurnBudget, ToolBudgetConfig, ResolvedToolBudget, ControlConfig, ResolvedControlConfig, CompletionBatchConfig, WaitToolConfig, ControlEvent, SubagentRunMode, AgentContract } from "./basic.ts";
import type { AcceptanceInput, UsageBudgetConfig, SingleResult, Details } from "./results.ts";
import type { ArtifactDirPreference, ArtifactConfig } from "./artifacts.ts";
import type { NestedRouteInfo } from "./async-execution.ts";
import type { IntercomEventBus } from "./error-handling.ts";
import type { ChildEnvironmentProfile } from "../../runs/shared/child-environment.ts";


export interface RunSyncOptions {
	/** Session id of the direct parent session for permission-system ask forwarding. */
	parentSessionId: string;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	usageBudget?: UsageBudgetConfig;
	/** Enforce maxTurns + graceTurns as a hard model-turn boundary. */
	enforceHardTurnLimit?: boolean;
	toolBudget?: ResolvedToolBudget;
	allowZeroToolBudget?: boolean;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	/** Exposes a non-terminating detach callback while the child is active. */
	onDetachReady?: (detach: (reason?: string) => boolean) => void;
	/** Internal foreground receipt proposal; returns true only when the outer waiter accepted it. */
	onDetachReceipt?: (result: SingleResult) => boolean;
	/** Authoritative terminal result, emitted only after the full detached run finalizes. */
	onDetachedExit?: (result: SingleResult) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	steerInboxDir?: string;
	steerCapabilityPath?: string;
	steerAckDir?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	/** Explicit child environment policy; ordinary interactive launches retain provider capability. */
	environmentProfile?: ChildEnvironmentProfile;
	/** Effective parent wait-tool setting propagated to the child runtime. */
	waitToolEnabled?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	/** Per-launch role-specific grants layered onto runtime defaults and the base Agent declaration. */
	extraTools?: string[];
	/** Per-launch policy revocations applied after defaults and additions resolve. */
	denyTools?: string[];
	nestedRoute?: NestedRouteInfo;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Ordered per-launch fallback models; overrides the Agent's configured fallbackModels. */
	fallbackModelsOverride?: string[];
	/** Override the agent's default thinking level for this run */
	thinkingOverride?: AgentConfig["thinking"];
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Optional subagent model-scope enforcement for fallback candidates */
	modelScope?: ModelScopeConfig;
	/** Skills to make available (overrides agent default if provided) */
	skills?: string[];
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	agentContract?: AgentContract;
	acceptance?: AcceptanceInput;
	acceptanceContext?: {
		mode?: SubagentRunMode;
		async?: boolean;
		dynamic?: boolean;
		dynamicGroup?: boolean;
	};
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
	/** Deliver grouped completion messages through an external acknowledged intercom listener. */
	resultDelivery?: boolean;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

interface ExtensionChainConfig {
	dynamicFanout?: {
		maxItems?: number;
	};
}

export interface ProactiveSkillSubagentsConfig {
	enabled?: boolean;
	minReferences?: number;
	maxRecommendations?: number;
	preferredAgent?: string;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

export interface ScheduledRunsConfig {
	enabled?: boolean;
	maxLatenessMs?: number;
	maxPending?: number;
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	/** Workflow UI and output language. Auto detects from the workflow goal. */
	workflowLanguage?: "auto" | "zh" | "en";
	/**
	 * Ceiling on workflow children running at once. Defaults to 4.
	 *
	 * This is both the default and the maximum: a Supervisor asking for more than
	 * this is clamped down, so one over-eager plan cannot burst past the limit the
	 * provider or machine can absorb. Remaining ready nodes queue in the pool.
	 */
	workflowConcurrency?: number;
	/** Maximum attempts for one workflow node before Supervisor intervention. Defaults to 3. */
	workflowMaxNodeAttempts?: number;
	/** Tool description variant registered for the parent-facing subagent tool. Defaults to full. */
	toolDescriptionMode?: ToolDescriptionMode;
	forceTopLevelAsync?: boolean;
	waitTool?: WaitToolConfig;
	defaultSessionDir?: string;
	singleRunOutputBaseDir?: string;
	maxSubagentDepth?: number;
	/** Optional cumulative session cap. Unset or 0 means unlimited. */
	maxSubagentSpawnsPerSession?: number;
	/** Global cap on simultaneously-running subagent tasks within a single run. Defaults to 20. */
	globalConcurrencyLimit?: number;
	control?: ControlConfig;
	completionBatch?: CompletionBatchConfig;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	usageBudget?: UsageBudgetConfig;
	parallel?: TopLevelParallelConfig;
	chain?: ExtensionChainConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	/** Where to store subagent artifact files. Defaults to "project" (cwd/.pi/agents-flow; legacy cwd/.pi-agents-flow is still readable). Set to "session" for pi session dir, or "temp" for OS temp. */
	artifactDir?: ArtifactDirPreference;
	intercomBridge?: IntercomBridgeConfig;
	proactiveSkillSubagents?: ProactiveSkillSubagentsConfig | false;
	scheduledRuns?: ScheduledRunsConfig;
}
