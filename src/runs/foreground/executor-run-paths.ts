import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canInvokeAgent, effectiveAgentInvocation, resolveAgentName, type AgentConfig, type AgentInvocationOrigin, type AgentScope } from "../../agents/agents.ts";
import { getArtifactsDir, getProjectChainRunsDir } from "../../shared/artifacts.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { resolveEffectiveThinking, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { executeChain } from "./chain-execution.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	forgetForegroundSteeringCleanup,
	foregroundSchedulingSettled,
	foregroundSteeringCleanupKey,
	foregroundSteeringPaths,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	trackForegroundSteeringCleanup,
	updateForegroundChild,
} from "./foreground-control.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { runSync } from "./execution.ts";
import { handleWatchdogToolAction, WATCHDOG_TOOL_ACTIONS } from "../../watchdog/tool-actions.ts";
import type { MainWatchdogRuntime } from "../../watchdog/runtime.ts";
import { buildModelCandidates, normalizeParentModel, resolveEffectiveSubagentModel, resolveModelCandidate, type ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	getStepAgents,
	isParallelStep,
	isDynamicParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { buildAsyncRunnerSteps, executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable } from "../background/async-execution.ts";
import {
	collectRequestedAgentNames,
	duplicateNames,
	escapeRegExp,
	firstChainAgent,
	firstRawChainTask,
	getRequestedModeLabel,
	isAsyncRunNotFound,
	isExactResumeError,
	isResumeAmbiguity,
	nestedRunAgent,
	nestedRunSessionFile,
	pathWithin,
	resolveAsyncEventGoal,
	resolveRequestedCwd,
	resumeTargetExact,
	canonicalizeAgentName,
} from "./executor-helpers.ts";
import type { AgentDefaultContextPolicy } from "./executor-validation.ts";
import {
	applySingleAgentLaunchDefaults,
	buildRequestedModeError,
	preflightForkSessionsForStaticTasks,
	resolveAgentDefaultContextPolicy,
	resolveEffectiveToolBudget,
	resolveRunTimeout,
	shouldForkAgent,
	toExecutionErrorResult,
	withForkThinkingNotes,
	withResolvedContext,
	wrapChainTasksForFork,
} from "./executor-validation.ts";
import type {
	ExecutionContextData,
	ExecutorDeps,
	SubagentParamsLike,
} from "./executor-types.ts";
import * as control from "./executor-control.ts";
const {
	removeForegroundControlIfIdle,
	getForegroundControl,
	formatForegroundActivity,
	nestedResolutionScopeForExecutor,
	trustedSessionRootsForStatus,
	spawnBudgetErrorResult,
	withSpawnBudgetStatus,
	hasActiveSubagentChildren,
	countRequestedSubagentSpawns,
	foregroundStatusResult,
	trimRememberedForegroundRuns,
	foregroundChildActivityFromProgress,
	rememberForegroundRun,
	applyControlEventToRememberedForegroundRun,
	updateRememberedForegroundChild,
	resolveForegroundResumeTarget,
	resolveResumeTarget,
	getAsyncInterruptTarget,
	emitControlNotification,
	interruptAsyncRun,
	appendStepToAsyncChain,
	validateNestedSessionFile,
	resolveNestedResumeTarget,
	waitForNestedControlResult,
	sendNestedControlRequest,
	directNestedAsyncInterrupt,
	directNestedAsyncSteer,
	interruptNestedRun,
	resumeLiveNestedRun,
	steerNestedRun,
	resumeAsyncRun,
	resultSummaryForIntercom,
	formatFailedSingleRunOutput,
	createForegroundControlNotifier,
	emitForegroundResultIntercom,
	maybeBuildForegroundIntercomReceipt,
	rememberParentModel,
} = control;

import type { ScheduledRunAction } from "../background/scheduled-runs.ts";
import { enqueueChainAppendRequest, readPendingChainAppendRequests, runnerStepOutputNames } from "../background/chain-append.ts";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";
import { createForkContextResolver, forkedChildRequiresThinkingOff } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { resolveTurnBudgetConfig } from "../shared/turn-budget.ts";
import { formatSpawnBudget, getSpawnBudgetSnapshot, grantSpawnBudget, preflightSpawnBudget, preflightSpawnBudgetGrant, reserveSpawnBudget } from "../shared/spawn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { usageBudgetExceededMessage, usageBudgetState, validateUsageBudgetConfig } from "../shared/usage-budget.ts";
import { intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { isAgentContractV1 } from "../shared/agent-contract.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage } from "../../shared/utils.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.ts";
import { formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup } from "../shared/parallel-handoff.ts";
import { summarizeContextModes, type ContextMode, type ContextSummary } from "../shared/context-mode.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { applySteeringRecoveryAgentConfig, buildRevivedAsyncTask, resolveAsyncResumeTarget, resolveAsyncRunLocation } from "../background/async-resume.ts";
import { deliverCheckpointDecisionRequest, deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.ts";
import { waitForSteeringAction } from "../background/steering.ts";
import { steerAsyncRun } from "./async-steering-action.ts";
import { stopAsyncRun } from "./async-stop-action.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveAsyncRootResultPath } from "../background/chain-root-attachment.ts";
import { attachRootChildrenToSteps, createNestedRoute, findNestedControlResult, resolveInheritedNestedRouteFromEnv, resolveNestedAsyncDir, resolveNestedParentAddressFromEnv, snapshotNestedEventFiles, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type AgentProgress,
	type AsyncStatus,
	type AcceptanceInput,
	type AgentContract,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type ForegroundRunControl,
	type IntercomEventBus,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SingleResult,
	type SubagentForegroundCompleteEvent,
	type ToolBudgetConfig,
	type TurnBudgetConfig,
	type UsageBudgetConfig,
	type SubagentRunMode,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SUBAGENT_ACTIONS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	wrapForkTask,
} from "../../shared/types.ts";

const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset", "grant-spawn-budget", "watchdog.configure"]);
interface TaskParam {
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

export function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-agents-flow package dependencies are installed." }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const parentModel = data.parentModel;
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
		currentModelProvider: parentModel?.provider,
		currentModel: parentModel,
		modelScope: data.modelScope,
		interactive: ctx.hasUI,
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = parentModel?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;

	if (hasTasks && params.tasks) {
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(task.model !== undefined ? { model: task.model } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
			...(task.output !== undefined && task.output !== true ? { output: task.output } : {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
			...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
			...(task.outputSchema !== undefined ? { outputSchema: task.outputSchema } : {}),
			...(task.agentContract !== undefined ? { agentContract: task.agentContract } : {}),
			...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
		}));
		return executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			resultMode: "parallel",
			goal: params.tasks[0]?.task ?? "",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index, task.model)),
			thinkingOverridesByFlatIndex: params.tasks.map((task, index) => thinkingOverrideForTask(task.agent, index, task.model)),
			contextForAgent: contextPolicy.contextForAgent,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const rawChain = params.chain as ChainStep[];
		const chain = wrapChainTasksForFork(rawChain, contextPolicy);
		return executeAsyncChain(id, {
			chain,
			task: params.task,
			goal: resolveAsyncEventGoal(params.task, rawChain),
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(chain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			contextForAgent: contextPolicy.contextForAgent,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveEffectiveSubagentModel(params.model as string | undefined, a.model, parentModel, availableModels, currentProvider, { scope: data.modelScope });
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			goal: params.task ?? "",
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
			context: contextPolicy.contextForAgent(params.agent!),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
			maxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
			agentContract: params.agentContract,
			structuredOutputSchema: params.outputSchema,
			acceptance: params.acceptance,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
		});
	}

	return null;
}

export async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], contextPolicy);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const chainCtx = normalizeParentModel(ctx.model) || !data.parentModel ? ctx : { ...ctx, model: data.parentModel };
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx: chainCtx,
		modelScope: data.modelScope,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		contextForAgent: contextPolicy.contextForAgent,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		agentContract: params.agentContract,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		nestedRoute: foregroundControl?.nestedRoute,
		chainSkills,
		chainDir: params.chainDir ?? getProjectChainRunsDir(effectiveCwd),
		dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
		worktreeBaseDir: deps.config.worktreeBaseDir,
		timeoutMs: data.timeoutMs,
		deadlineAt: data.deadlineAt,
		turnBudget: data.turnBudget,
		onDetachedExit: (index, result) => {
			try {
				updateRememberedForegroundChild(deps.state, { runId, mode: "chain", cwd: effectiveCwd, sessionId: data.parentSessionId, index, result, events: deps.pi.events });
			} finally {
				removeForegroundControlIfIdle(deps.state, runId);
			}
		},
		onForegroundChildSettled: () => {
			removeForegroundControlIfIdle(deps.state, runId);
		},
		toolBudget: data.toolBudget,
		usageBudget: data.usageBudget,
		configToolBudget: data.configToolBudget,
		globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		capabilityCeiling: data.capabilityCeiling,
	});

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-agents-flow package dependencies are installed." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
		const parentModel = data.parentModel;
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
			currentModelProvider: parentModel?.provider,
			currentModel: parentModel,
			modelScope: data.modelScope,
			interactive: ctx.hasUI,
		};
		const rawAsyncChain = chainResult.requestedAsync.chain;
		const asyncChain = wrapChainTasksForFork(rawAsyncChain, contextPolicy);
		const firstAgent = firstChainAgent(rawAsyncChain);
		return executeAsyncChain(id, {
			chain: asyncChain,
			task: params.task,
			goal: resolveAsyncEventGoal(params.task, rawAsyncChain, firstAgent ? shouldForkAgent(contextPolicy, firstAgent) : false),
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForTask, deps.config.chain?.dynamicFanout?.maxItems),
			thinkingOverridesByFlatIndex: collectChainThinkingOverrides(asyncChain, thinkingOverrideForTask, deps.config.chain?.dynamicFanout?.maxItems),
			contextForAgent: contextPolicy.contextForAgent,
			dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
			maxSubagentDepth: currentMaxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			worktreeBaseDir: deps.config.worktreeBaseDir,
			controlConfig,
			agentContract: params.agentContract,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			nestedRoute: data.nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
			usageBudget: data.usageBudget,
			configToolBudget: data.configToolBudget,
			capabilityCeiling: data.capabilityCeiling,
			globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
		});
	}

	const rawChainDetails = chainResult.details ? { ...chainResult.details, runId, timeoutMs: data.timeoutMs } : undefined;
	if (foregroundControl && rawChainDetails) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, rawChainDetails.results, foregroundControl.nestedChildren);
		rawChainDetails.totalCost = sumResultsCost(rawChainDetails.results);
		rawChainDetails.usageBudget = usageBudgetState(data.usageBudget, rawChainDetails.totalCost);
	}
	const chainDetails = rawChainDetails ? compactForegroundDetails(rawChainDetails) : undefined;
	if (chainDetails) rememberForegroundRun(deps.state, { runId, mode: "chain", cwd: effectiveCwd, sessionId: data.parentSessionId, results: chainDetails.results, checkpoint: chainDetails.checkpoint });
	const intercomReceipt = chainDetails && !chainDetails.results.some((result) => result.interrupted || result.detached)
		? await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "chain",
			details: chainDetails,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		})
		: null;
	if (intercomReceipt) {
		return {
			...chainResult,
			content: [{ type: "text", text: intercomReceipt.text }],
			details: intercomReceipt.details,
		};
	}

	return chainDetails ? { ...chainResult, details: chainDetails } : chainResult;
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	taskDescriptions: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	state: SubagentState;
	intercomEvents: IntercomEventBus;
	parentSessionId: string | null;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: ForkSessionFileForTask;
	thinkingOverrideForTask: ForkThinkingOverrideForTask;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	outputBaseDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	progressDir: string;
	maxSubagentDepths: number[];
	waitToolEnabled?: boolean;
	availableModels: ModelInfo[];
	modelScope?: ModelScopeConfig;
	parentModel?: ParentModel;
	modelOverrides: (string | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	contextPolicy: AgentDefaultContextPolicy;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	globalSemaphore?: Semaphore;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	usageBudget?: UsageBudgetConfig;
	toolBudgets: (ResolvedToolBudget | undefined)[];
	agentContract?: AgentContract;
}
export function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

export function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
	baseDir: ExtensionConfig["worktreeBaseDir"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
				baseDir,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

export function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

export function resolveSingleRunOutputBaseDir(deps: ExecutorDeps, artifactsDir: string, runId: string): string {
	return deps.config.singleRunOutputBaseDir
		? path.resolve(deps.expandTilde(deps.config.singleRunOutputBaseDir))
		: path.join(artifactsDir, "outputs", runId);
}

export function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

export function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

export function finalizeParallelWorktreeHandoff(input: {
	worktreeSetup: WorktreeSetup;
	artifactsDir: string;
	runId: string;
	cwd: string;
	tasks: TaskParam[];
	results: SingleResult[];
}): { suffix: string; reference?: NonNullable<Details["parallelHandoff"]> } {
	const diffsDir = path.join(input.artifactsDir, "worktree-diffs", input.runId);
	const diffs = diffWorktrees(input.worktreeSetup, input.tasks.map((task) => task.agent), diffsDir);
	const cleanup = cleanupWorktrees(input.worktreeSetup);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	try {
		const reference = writeParallelHandoffGroup({
			manifestPath: parallelHandoffPath(input.artifactsDir, input.runId),
			runId: input.runId,
			mode: "parallel",
			source: "foreground",
			cwd: input.cwd,
			stepIndex: 0,
			flatStartIndex: 0,
			setup: input.worktreeSetup,
			diffs,
			cleanup,
			results: input.results.map((result) => ({
				agent: result.agent,
				status: resolveSubagentResultStatus({
					exitCode: result.exitCode,
					interrupted: result.interrupted,
					detached: result.detached,
					state: result.stopped ? "stopped" : undefined,
					processSignal: result.processSignal,
					timedOut: result.timedOut,
					stopped: result.stopped,
					turnBudgetExceeded: result.turnBudgetExceeded,
				}),
				summary: resultSummaryForIntercom(result),
				...(result.artifactPaths?.outputPath ? { outputPath: result.artifactPaths.outputPath } : {}),
				...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
				...(result.structuredOutputPath ? { structuredOutputPath: result.structuredOutputPath } : {}),
				...(result.sessionFile ? { sessionPath: result.sessionFile } : {}),
			})),
		});
		return {
			suffix: [diffSummary, formatParallelHandoffReference(reference)].filter(Boolean).join("\n\n"),
			reference,
		};
	} catch (error) {
		return { suffix: [diffSummary, formatParallelHandoffError(error)].filter(Boolean).join("\n\n") };
	}
}

export function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	outputBaseDir: string;
	worktreeSetup?: WorktreeSetup;
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd, input.outputBaseDir);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

export async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	// Pre-warm fork session files sequentially before concurrent dispatch to avoid
	// races where multiple workers simultaneously try to branch the same parent session.
	for (let i = 0; i < input.tasks.length; i++) {
		input.sessionFileForTask(input.tasks[i]!.agent, i, input.modelOverrides[i]);
	}
	const completedResults: SingleResult[] = [];
	if (input.foregroundControl) retainForegroundSchedulingOwner(input.foregroundControl);
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const budgetState = usageBudgetState(input.usageBudget, sumResultsCost(completedResults));
		if (budgetState?.exhausted) {
			return {
				index,
				agent: task.agent,
				task: input.taskTexts[index] ?? "(skipped)",
				exitCode: 1,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				error: usageBudgetExceededMessage(budgetState),
				skipped: true,
			} as SingleResult;
		}
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.progressDir, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd, input.outputBaseDir);
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
			agentConfig,
		);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			const model = input.modelOverrides[index];
			const thinking = resolveEffectiveThinking(model, input.thinkingOverrideForTask(task.agent, index, model));
			beginForegroundChild(input.foregroundControl, {
				index,
				agent: task.agent,
				description: input.taskDescriptions[index],
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				interrupt: () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					return true;
				},
			});
		}
		const structuredRuntime = task.outputSchema
			? createStructuredOutputRuntime(task.outputSchema, path.join(input.artifactsDir, "structured-output", input.runId))
			: undefined;
		let detachedReceipt = false;
		const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
			parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
			context: input.contextPolicy.contextForAgent(task.agent),
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForTask(task.agent, index, input.modelOverrides[index]),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			outputPath,
			outputMode: behavior?.outputMode,
			maxSubagentDepth: input.maxSubagentDepths[index],
			waitToolEnabled: input.waitToolEnabled,
			capabilityCeiling: input.capabilityCeiling,
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			onDetachedExit: (result) => {
				try {
					updateRememberedForegroundChild(input.state, { runId: input.runId, mode: "parallel", cwd: taskCwd, sessionId: input.parentSessionId, index, result, events: input.intercomEvents });
				} finally {
					try {
						if (input.foregroundControl) finishForegroundChild(input.foregroundControl, index);
					} finally {
						removeForegroundControlIfIdle(input.state, input.runId);
					}
				}
			},
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			thinkingOverride: input.thinkingOverrideForTask(task.agent, index, input.modelOverrides[index]),
			availableModels: input.availableModels,
			preferredModelProvider: input.parentModel?.provider,
			modelScope: input.modelScope,
			skills: effectiveSkills === false ? [] : effectiveSkills,
			structuredOutput: structuredRuntime,
			agentContract: task.agentContract ?? input.agentContract,
			acceptance: task.acceptance,
			acceptanceContext: { mode: "parallel" },
			timeoutMs: input.timeoutMs,
			deadlineAt: input.deadlineAt,
			turnBudget: input.turnBudget,
			toolBudget: input.toolBudgets[index],
			onUpdate: input.onUpdate
				? (progressUpdate) => {
					const stepResults = progressUpdate.details?.results || [];
					const stepProgress = progressUpdate.details?.progress || [];
					if (input.foregroundControl && stepProgress.length > 0) {
						updateForegroundChild(input.foregroundControl, index, stepProgress[0]);
					}
					if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
					if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
					const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
					const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
					input.onUpdate?.({
						content: progressUpdate.content,
						details: {
							mode: "parallel",
							results: mergedResults,
							progress: mergedProgress,
							controlEvents: progressUpdate.details?.controlEvents,
							totalSteps: input.tasks.length,
						},
					});
				}
				: undefined,
		}).then((result) => {
			detachedReceipt = result.detached === true;
			return result;
		}).finally(() => {
			// mapConcurrent rejects before siblings settle, so every attached child
			// attempts idle removal after releasing its own control. Detached receipts
			// transfer both responsibilities to the authoritative exit callback.
			if (!detachedReceipt) {
				if (input.foregroundControl) finishForegroundChild(input.foregroundControl, index);
				removeForegroundControlIfIdle(input.state, input.runId);
			}
		});
		completedResults.push(result);
		return result;
	}, input.globalSemaphore, () => {
		if (input.foregroundControl) settleForegroundSchedulingOwner(input.foregroundControl);
		removeForegroundControlIfIdle(input.state, input.runId);
	});
}

export async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);
	const toolBudgets: (ResolvedToolBudget | undefined)[] = [];
	for (let index = 0; index < tasks.length; index++) {
		const resolved = resolveEffectiveToolBudget({ stepBudget: tasks[index]?.toolBudget, runBudget: data.toolBudget, agentBudget: agentConfigs[index]?.toolBudget, configBudget: data.configToolBudget });
		if (resolved.error) return buildParallelModeError(resolved.error);
		toolBudgets.push(resolved.toolBudget);
	}

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const parentModel = data.parentModel;
	const currentProvider = parentModel?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let taskTexts = tasks.map((t) => t.task);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined && task.output !== true ? { output: task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(skillOverrides[index] !== undefined ? { skills: skillOverrides[index] } : {}),
		...(task.model !== undefined ? { model: task.model } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveEffectiveSubagentModel(behaviorOverrides[i]?.model, agentConfigs[i]?.model, parentModel, availableModels, currentProvider, { scope: data.modelScope }),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, behaviorOverrides[i]!),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 40, maxWidth: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model !== undefined) {
				modelOverrides[i] = resolveEffectiveSubagentModel(override.model, agentConfigs[i]?.model, parentModel, availableModels, currentProvider, { scope: data.modelScope });
				behaviorOverrides[i]!.model = override.model;
			}
			if (override?.output !== undefined) behaviorOverrides[i]!.output = override.output;
			if (override?.reads !== undefined) behaviorOverrides[i]!.reads = override.reads;
			if (override?.progress !== undefined) behaviorOverrides[i]!.progress = override.progress;
			if (override?.skills !== undefined) {
				skillOverrides[i] = override.skills;
				behaviorOverrides[i]!.skills = override.skills;
			}
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-agents-flow package dependencies are installed." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: parentModel?.provider,
				currentModel: parentModel,
				modelScope: data.modelScope,
				interactive: ctx.hasUI,
			};
			const parallelTasks = tasks.map((t, i) => {
				const taskText = shouldForkAgent(contextPolicy, t.agent) ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!;
				const progress = taskDisallowsFileUpdates(taskText) ? false : behaviorOverrides[i]?.progress;
				return {
					agent: t.agent,
					task: taskText,
					cwd: t.cwd,
					...(behaviorOverrides[i]?.model !== undefined ? { model: behaviorOverrides[i]!.model } : {}),
					...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
					...(behaviorOverrides[i]?.output !== undefined ? { output: behaviorOverrides[i]!.output } : {}),
					...(behaviorOverrides[i]?.outputMode !== undefined ? { outputMode: behaviorOverrides[i]!.outputMode } : {}),
					...(behaviorOverrides[i]?.reads !== undefined ? { reads: behaviorOverrides[i]!.reads } : {}),
					...(progress !== undefined ? { progress } : {}),
					...(t.toolBudget !== undefined ? { toolBudget: t.toolBudget } : {}),
					...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
					...(t.acceptance !== undefined ? { acceptance: t.acceptance } : {}),
					...(t.agentContract !== undefined ? { agentContract: t.agentContract } : {}),
				};
			});
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
				resultMode: "parallel",
				goal: taskTexts[0] ?? "",
				agents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((task, index) => sessionFileForTask(task.agent, index, modelOverrides[index])),
				thinkingOverridesByFlatIndex: tasks.map((task, index) => thinkingOverrideForTask(task.agent, index, modelOverrides[index])),
				contextForAgent: contextPolicy.contextForAgent,
				maxSubagentDepth: currentMaxSubagentDepth,
				waitToolEnabled: deps.waitToolEnabled,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				worktreeBaseDir: deps.config.worktreeBaseDir,
				controlConfig,
				agentContract: params.agentContract,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				nestedRoute: data.nestedRoute,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				usageBudget: data.usageBudget,
				toolBudget: data.toolBudget,
				configToolBudget: data.configToolBudget,
				globalConcurrencyLimit: deps.config.globalConcurrencyLimit,
			});
		}
	}

	const behaviors = tasks.map((task, index) => {
		let behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfigs[index]!, behaviorOverrides[index]!), taskTexts[index]);
		if (behaviorOverrides[index]?.output === undefined && typeof behavior.output === "string" && !path.isAbsolute(behavior.output)) {
			behavior = { ...behavior, output: path.join("parallel-0", `${index}-${task.agent}`, behavior.output) };
		}
		return behavior;
	});
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
		deps.config.worktreeBaseDir,
	);
	if (errorResult) return errorResult;

	let worktreeFinalized = false;
	try {
		const outputBaseDir = path.join(artifactsDir, "outputs", runId);
		const duplicateOutputError = findDuplicateParallelOutputPath({
			tasks,
			behaviors,
			paramsCwd: effectiveCwd,
			ctxCwd: ctx.cwd,
			outputBaseDir,
			worktreeSetup,
		});
		if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
		for (let index = 0; index < tasks.length; index++) {
			const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd, worktreeSetup, index);
			const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd, outputBaseDir);
			const validationError = validateFileOnlyOutputMode(behaviors[index]?.outputMode, outputPath, `Parallel task ${index + 1} (${tasks[index]!.agent})`);
			if (validationError) return buildParallelModeError(validationError);
		}

		const parallelProgressPrecreated = firstProgressIndex !== -1;
		const parallelProgressDir = path.join(artifactsDir, "progress", runId);
		if (parallelProgressPrecreated) writeInitialProgressFile(parallelProgressDir);

		const taskDescriptions = taskTexts.map((taskText) => taskText.trim());
		for (let i = 0; i < taskTexts.length; i++) {
			if (shouldForkAgent(contextPolicy, tasks[i]!.agent)) taskTexts[i] = wrapForkTask(taskTexts[i]!);
		}

		const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			taskDescriptions,
			agents,
			ctx,
			state: deps.state,
			intercomEvents: deps.pi.events,
			parentSessionId: data.parentSessionId,
			capabilityCeiling: data.capabilityCeiling,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			sessionFileForTask,
			thinkingOverrideForTask,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			outputBaseDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			progressDir: parallelProgressDir,
			availableModels,
			modelScope: data.modelScope,
			parentModel,
			modelOverrides,
			behaviors,
			firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
			controlConfig,
			contextPolicy,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			globalSemaphore: new Semaphore(deps.config.globalConcurrencyLimit ?? DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
			maxSubagentDepths,
			waitToolEnabled: deps.waitToolEnabled,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
			timeoutMs: data.timeoutMs,
			deadlineAt,
			turnBudget: data.turnBudget,
			usageBudget: data.usageBudget,
			toolBudgets,
			agentContract: params.agentContract,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		if (foregroundControl) {
			updateForegroundNestedProjection(foregroundControl);
			attachRootChildrenToSteps(runId, results, foregroundControl.nestedChildren);
		}
		let handoff: ReturnType<typeof finalizeParallelWorktreeHandoff> | undefined;
		if (worktreeSetup) {
			worktreeFinalized = true;
			handoff = finalizeParallelWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: effectiveCwd, tasks, results });
		}
		const interrupted = results.find((result) => result.interrupted);
		const totalCost = sumResultsCost(results);
		const details = compactForegroundDetails({
			mode: "parallel",
			runId,
			timeoutMs: data.timeoutMs,
			results,
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			totalChildUsage: sumResultsUsage(results),
			totalCost,
			usageBudget: usageBudgetState(data.usageBudget, totalCost),
			...(handoff?.reference ? { parallelHandoff: handoff.reference } : {}),
		});
		rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, sessionId: data.parentSessionId, results: details.results });
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details,
			};
		}
		const detachedIndex = results.findIndex((result) => result.detached);
		const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
		if (detached) {
			return {
				content: [{ type: "text", text: `Parallel run detached for intercom coordination (${detached.agent}). Reply to the supervisor request first, then wait with subagent_wait({ id: "${runId}" }). Use subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.` }],
				details,
			};
		}

		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "parallel",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
			};
		}

		const worktreeSuffix = handoff?.suffix ?? "";
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
				timedOut: result.timedOut,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details,
		};
	} finally {
		if (worktreeSetup && !worktreeFinalized) cleanupWorktrees(worktreeSetup);
	}
}

export async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const effectiveToolBudget = resolveEffectiveToolBudget({ runBudget: data.toolBudget, agentBudget: agentConfig.toolBudget, configBudget: data.configToolBudget });
	if (effectiveToolBudget.error) return toExecutionErrorResult(params, new Error(effectiveToolBudget.error), data.contextPolicy.contextSummary);

	const parentModel = data.parentModel;
	const currentProvider = parentModel?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveEffectiveSubagentModel(
		params.model as string | undefined,
		agentConfig.model,
		parentModel,
		availableModels,
		currentProvider,
		{ scope: data.modelScope },
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "95%", minWidth: 40, maxWidth: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model !== undefined) modelOverride = resolveEffectiveSubagentModel(override.model, agentConfig.model, parentModel, availableModels, currentProvider, { scope: data.modelScope });
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-agents-flow package dependencies are installed." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: parentModel?.provider,
				currentModel: parentModel,
				modelScope: data.modelScope,
				interactive: ctx.hasUI,
			};
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(task) : task,
				goal: task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
				context: contextPolicy.contextForAgent(params.agent!),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				outputMode: effectiveOutputMode,
				outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
				modelOverride,
				thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
				maxSubagentDepth,
				waitToolEnabled: deps.waitToolEnabled,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				worktreeBaseDir: deps.config.worktreeBaseDir,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
				nestedRoute: data.nestedRoute,
				agentContract: params.agentContract,
				structuredOutputSchema: params.outputSchema,
				acceptance: params.acceptance,
				timeoutMs: data.timeoutMs,
				turnBudget: data.turnBudget,
				toolBudget: effectiveToolBudget.toolBudget,
				usageBudget: data.usageBudget,
				allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
			});
		}
	}

	if (shouldForkAgent(contextPolicy, params.agent!)) {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd, resolveSingleRunOutputBaseDir(deps, artifactsDir, runId));
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	const structuredRuntime = params.outputSchema
		? createStructuredOutputRuntime(params.outputSchema, artifactConfig.enabled ? path.join(artifactsDir, "structured-output", runId) : undefined)
		: undefined;
	task = injectSingleOutputInstruction(task, outputPath, agentConfig);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	let detachForeground: ((reason?: string) => boolean) | undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const steeringPaths = foregroundSteeringPaths(foregroundControl, 0);
	if (foregroundControl) {
		const thinking = resolveEffectiveThinking(modelOverride, thinkingOverrideForTask(params.agent!, 0, modelOverride));
		beginForegroundChild(foregroundControl, {
			index: 0,
			agent: params.agent!,
			description: foregroundControl.description,
			...(modelOverride ? { model: modelOverride } : {}),
			...(thinking ? { thinking } : {}),
			...steeringPaths,
			interrupt: () => {
				if (interruptController.signal.aborted) return false;
				interruptController.abort();
				return true;
			},
			detach: () => detachForeground?.("user request") === true,
		});
	}

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) updateForegroundChild(foregroundControl, 0, update.details?.progress?.[0]);
			onUpdate(update);
		}
		: undefined;

	const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
	let r: Awaited<ReturnType<typeof runSync>>;
	try {
		r = await runSync(ctx.cwd, agents, params.agent!, task, {
			parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
			context: data.contextPolicy.contextForAgent(params.agent!),
			cwd: effectiveCwd,
			signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: deps.pi.events,
			runId,
			sessionDir: sessionDirForIndex(0),
			sessionFile: sessionFileForTask(params.agent!, 0, modelOverride),
			share: shareEnabled,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			maxOutput: params.maxOutput,
			outputPath,
			outputMode: effectiveOutputMode,
			maxSubagentDepth,
			waitToolEnabled: deps.waitToolEnabled,
			onUpdate: forwardSingleUpdate,
			controlConfig,
			onControlEvent,
			intercomSessionName: childIntercomTarget,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			...steeringPaths,
			nestedRoute: foregroundControl?.nestedRoute,
			index: 0,
			modelOverride,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0, modelOverride),
			availableModels,
			preferredModelProvider: currentProvider,
			modelScope: data.modelScope,
			skills: effectiveSkills,
			structuredOutput: structuredRuntime,
			agentContract: params.agentContract,
			acceptance: params.acceptance,
			acceptanceContext: { mode: "single" },
			onDetachReady: (detach) => {
				detachForeground = detach;
			},
			onDetachedExit: (result) => {
				try {
					try {
						updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, sessionId: data.parentSessionId, index: 0, result, events: deps.pi.events });
					} catch {
						// Remembered foreground state is best-effort; run history and cleanup must still complete.
					}
				} finally {
					try {
						if (!artifactConfig.enabled) cleanupStructuredOutputRuntime(structuredRuntime);
					} finally {
						try {
							if (foregroundControl) finishForegroundChild(foregroundControl, 0);
						} finally {
							removeForegroundControlIfIdle(deps.state, runId);
						}
					}
				}
				recordRun(params.agent!, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			},
			timeoutMs: data.timeoutMs,
			deadlineAt,
			turnBudget: data.turnBudget,
			enforceHardTurnLimit: params.enforceHardTurnLimit,
			toolBudget: effectiveToolBudget.toolBudget,
			capabilityCeiling: data.capabilityCeiling,
			extraTools: params.extraTools,
			denyTools: params.denyTools,
			allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
		});
	} finally {
		// An attached runSync rejection still owns its child and structured runtime.
		// A successful detached receipt transfers both to onDetachedExit while the
		// authoritative completion remains live.
		if (!r?.detached) {
			if (!artifactConfig.enabled) cleanupStructuredOutputRuntime(structuredRuntime);
			if (foregroundControl) finishForegroundChild(foregroundControl, 0);
		}
	}
	if (!r.detached) {
		recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);
	}

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	if (foregroundControl) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
	}
	const totalCost = sumResultsCost([r]);
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		timeoutMs: data.timeoutMs,
		results: [r],
		...(data.turnBudget ? { turnBudget: data.turnBudget } : {}),
		...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
		totalChildUsage: sumResultsUsage([r]),
		totalCost,
		usageBudget: usageBudgetState(data.usageBudget, totalCost),
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, sessionId: data.parentSessionId, results: details.results });

	if (!r.detached && !r.interrupted) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first, then wait with subagent_wait({ id: "${runId}" }). Use subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: formatFailedSingleRunOutput(r, finalizedOutput.displayOutput) }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}

export function inferExecutionMode(params: SubagentParamsLike): SubagentRunMode {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

export function duplicateSubagentCallResult(params: SubagentParamsLike): AgentToolResult<Details> {
	return {
		content: [{
			type: "text",
			text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
		}],
		isError: true,
		details: { mode: inferExecutionMode(params), results: [] },
	};
}

export function omitExecutionModeActionAlias(params: SubagentParamsLike): SubagentParamsLike {
	const action = params.action?.toLowerCase();
	if (action === "single" && (params.agent !== undefined || params.task !== undefined)) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	if ((action === "parallel" || action === "tasks") && (params.tasks?.length ?? 0) > 0) {
		const rest = { ...params };
		delete rest.action;
		return rest;
	}
	return params;
}

