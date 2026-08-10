import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentConfig, AgentScope } from "../../agents/agent-types.ts";
import type { IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import type { ChainStep } from "../../shared/settings.ts";
import type {
	AcceptanceInput,
	AgentContract,
	ArtifactConfig,
	ControlConfig,
	Details,
	ExtensionConfig,
	JsonSchemaObject,
	MaxOutputConfig,
	NestedRouteInfo,
	ResolvedControlConfig,
	ResolvedTurnBudget,
	ResolvedToolBudget,
	SubagentState,
	ToolBudgetConfig,
	TurnBudgetConfig,
	UsageBudgetConfig,
} from "../../shared/types.ts";
import type { MainWatchdogRuntime } from "../../watchdog/runtime.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import type { ContextMode, ContextSummary } from "../shared/context-mode.ts";
import type { ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";

export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	outputSchema?: JsonSchemaObject;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	toolBudget?: ToolBudgetConfig;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
	agent?: string;
	chainName?: string;
	config?: unknown;
	task?: string;
	message?: string;
	steeringRecovery?: boolean;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	foregroundOnly?: boolean;
	timeoutMs?: number;
	maxRuntimeMs?: number;
	turnBudget?: TurnBudgetConfig;
	/** Internal-only strict turn-boundary enforcement for versioned foreground delegation. */
	enforceHardTurnLimit?: boolean;
	toolBudget?: ToolBudgetConfig;
	usageBudget?: UsageBudgetConfig;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	thinking?: string | false;
	scope?: string;
	target?: string;
	skill?: string | string[] | boolean;
	/** Per-launch role-specific grants layered onto runtime defaults and the base Agent declaration. */
	extraTools?: string[];
	/** Per-launch policy revocations applied after defaults and additions resolve. */
	denyTools?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputSchema?: JsonSchemaObject;
	agentScope?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	schedule?: string;
	scheduleName?: string;
	additional?: number;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	waitToolEnabled?: boolean;
	handleScheduledRunAction?: (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
	watchdog?: MainWatchdogRuntime;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; modelScope?: ModelScopeConfig };
	allowMutatingManagementActions?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

export type ForkSessionFileForTask = (agentName: string, idx?: number, modelOverride?: string) => string | undefined;
export type ForkThinkingOverrideForTask = (agentName: string, idx?: number, modelOverride?: string) => AgentConfig["thinking"] | undefined;

export interface AgentDefaultContextPolicy {
	params: SubagentParamsLike;
	contextForAgent(agentName: string): ContextMode;
	contextSummary?: ContextSummary;
	usesFork: boolean;
}

export interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (result: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: ForkSessionFileForTask;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	usageBudget?: UsageBudgetConfig;
	allowZeroToolBudget?: boolean;
	configToolBudget?: ResolvedToolBudget;
	contextPolicy: AgentDefaultContextPolicy;
	modelScope?: ModelScopeConfig;
	parentModel?: ParentModel;
	parentSessionId: string | null;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}
