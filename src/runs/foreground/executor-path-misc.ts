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

