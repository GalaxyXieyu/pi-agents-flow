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

