/**
 * Instance-owned core extension factory (UI-free).
 *
 * Holds the shared lifecycle, tool registration, and runtime wiring used by both
 * the interactive package entry (`src/extension/index.ts`) and the server-side
 * headless entry (`src/extension/headless.ts`). Both resolve to the exact same
 * workflow / subagent / activity tool registration functions below — there is no
 * second scheduler and no divergent copy of the shared registration path.
 *
 * This module is UI-free: it imports no pi-tui module and no `src/tui/*` module.
 * The caller injects the decision seams that differ by deployment:
 *   - `interaction`: TUI workflow interaction (interactive) or the headless
 *     HeadlessDecisionProvider-backed interaction.
 *   - `clarifier`: TUI chain clarifier (interactive) or the headless AI
 *     clarifier.
 *   - `ui.decorate`: optional interactive-only hook that attaches TUI message
 *     renderers, the Activity Dock controller, and interactive slash/workflow
 *     commands after the shared tools are registered.
 * The interactive caller passes render presentations (TUI) into
 * `ui.presentations`; the headless caller omits them entirely so the core
 * resolves with zero pi-tui / src/tui modules.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { discoverAgents } from "../agents/agents.ts";
import { ensureAccessibleDir } from "../shared/accessible-dir.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { ensureProjectRuntimeRoot } from "../shared/project-runtime.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { buildActivitySnapshot } from "../activity/projection.ts";
import { cleanupForegroundSteeringDirs } from "../runs/foreground/foreground-control.ts";
import { SubagentParams } from "./schemas.ts";
import { validateChainInput } from "./chain-validation.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { ExecutionClarifier } from "../runs/shared/execution-clarifier.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import type { MainWatchdogRuntime } from "../watchdog/runtime.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { registerSubagentRpcBridge } from "./rpc.ts";
import { clearSlashSnapshots, restoreSlashFinalSnapshots } from "../slash/slash-live-state.ts";
import { resolveWaitToolConfig } from "../runs/background/subagent-wait.ts";
import { registerWaitTool } from "../runs/background/wait-tool.ts";
import { drainOutstandingWork } from "../runs/background/auto-drain.ts";
import registerSubagentNotify from "../runs/background/notify.ts";
import { handleSubagentSteeringNotice, SUBAGENT_STEERING_MESSAGE_TYPE, type SubagentSteeringMessageDetails } from "./steering-notices.ts";
import { SUBAGENT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { resolveCurrentSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { loadConfig, type ExtensionConfig } from "./config.ts";
import { buildSubagentToolDescription } from "./tool-description.ts";
import {
	type Details,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_STEERING_NOTICE_EVENT,
	resolveMaxSubagentSpawnsPerSession,
} from "../shared/types.ts";
import {
	clearPendingForegroundControlNotices,
	handleSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";
import { createWorkflowController, type WorkflowController } from "../workflows/controller.ts";
import { createWorkflowDelegationAdapter } from "../workflows/delegation-adapter.ts";
import { createWorkflowRuntime, type WorkflowRuntime } from "../workflows/runtime.ts";
import { registerWorkflowAssetsTool, registerWorkflowTool, type WorkflowAssetsPresentation, type WorkflowToolPresentation } from "../workflows/tool.ts";
import type { WorkflowInteraction } from "../workflows/interaction.ts";
import { createWorkflowTodoAdapter, WORKFLOW_TODO_SNAPSHOT_ENTRY_TYPE, type WorkflowTodoAdapter } from "../workflows/todo-adapter.ts";

export { loadConfig } from "./config.ts";

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
export function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

export function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export interface SubagentToolPresentation {
	renderCall?: ToolDefinition<typeof SubagentParams, Details>["renderCall"];
	renderResult?: ToolDefinition<typeof SubagentParams, Details>["renderResult"];
}

/**
 * Minimal structural view of the interactive-only Activity Dock controller used by
 * the shared lifecycle handlers. The interactive entry attaches a concrete TUI
 * controller here; headless leaves it unset. This local shape keeps `core.ts`
 * free of any `src/tui/*` import.
 */
export interface CoreActivityDock {
	refresh(): void;
	setContext(ctx: ExtensionContext): void;
	dispose(): void;
}

export interface ExtensionCore {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	executor: ReturnType<typeof createSubagentExecutor>;
	workflowController: WorkflowController;
	workflowRuntime: WorkflowRuntime;
	workflowTodoAdapter: WorkflowTodoAdapter;
	/** Optional interactive-only Activity Dock. Unset in headless. */
	activityDock?: CoreActivityDock;
	rpcBridge: ReturnType<typeof registerSubagentRpcBridge>;
	supervisorChannel: ReturnType<typeof createNativeSupervisorChannel>;
	scheduledRunManager: ReturnType<typeof createScheduledRunManager>;
	completionNotifier: ReturnType<typeof registerSubagentNotify>;
	slashBridge: ReturnType<typeof registerSlashSubagentBridge>;
	promptTemplateBridge: ReturnType<typeof registerPromptTemplateDelegationBridge>;
	ensurePoller: () => void;
}

export interface ExtensionCoreOptions {
	pi: ExtensionAPI;
	interaction: WorkflowInteraction;
	clarifier: ExecutionClarifier;
	/** Interactive-only subagent watchdog runtime (UI-free type). Omit for headless. */
	watchdog?: MainWatchdogRuntime;
	/**
	 * Child environment policy for every subagent launch. Interactive deployments
	 * leave it unset (`"interactive"`); headless passes `"minimal"` so children
	 * get a minimal env with explicit parent identity and no secret/MCP/extensions
	 * sentinels.
	 */
	environmentProfile?: import("../runs/shared/child-environment.ts").ChildEnvironmentProfile;
	/**
	 * Interactive-only UI assembly. `presentations` runs after the controllers
	 * are built but before the shared tools are registered; `decorate` runs after
	 * the tools are registered and attaches TUI renderers, the Activity Dock, and
	 * interactive commands. Omit the whole `ui` block for headless.
	 */
	ui?: {
		presentations: (core: ExtensionCore) => {
			workflowPresentation?: WorkflowToolPresentation;
			workflowAssetsPresentation?: WorkflowAssetsPresentation;
			subagentPresentation?: SubagentToolPresentation;
		};
		decorate: (core: ExtensionCore) => void;
	};
}

/**
 * Shared instance-owned core factory. Registers the shared subagent/workflow/
 * activity tools and lifecycle wiring exactly once per instance, and returns the
 * runtime handles so the interactive entry can attach TUI presentation and the
 * headless entry can attach the server-side decision provider and audit sink.
 */
export function createExtensionCore(options: ExtensionCoreOptions): ExtensionCore {
	const pi = options.pi;
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		throw new Error("Extension core must not be constructed in subagent child mode.");
	}
	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const config = loadConfig();
	const waitToolConfig = resolveWaitToolConfig(config.waitTool);
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	// Best-effort migrate legacy project runtime when extension loads in a project cwd.
	try {
		if (process.cwd()) ensureProjectRuntimeRoot(process.cwd());
	} catch {
		// Non-fatal: later write paths also migrate.
	}

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		artifactDirPreference: config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
		parentSessionFile: null,
		subagentInProgress: false,
		subagentSpawns: {
			sessionId: null,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		},
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};

	const supervisorChannel = createNativeSupervisorChannel(pi, state);
	const completionNotifier = registerSubagentNotify(pi, state, { batchConfig: config.completionBatch });
	let workflowCompletionUnsubscribe: (() => void) | undefined;
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
		{
			notifier: completionNotifier,
			deliverIntercomResults: config.intercomBridge?.resultDelivery !== false,
		},
	);

	const { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	let executorExecute: ((id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext, origin?: "model" | "user") => Promise<AgentToolResult<Details>>) | undefined;
	const scheduledRunManager = createScheduledRunManager({
		config,
		launch: (params, ctx, signal) => {
			if (!executorExecute) {
				return Promise.resolve({
					content: [{ type: "text", text: "Scheduled subagent launch is unavailable (executor not ready)." }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				});
			}
			return executorExecute(randomUUID(), params, signal, undefined, ctx);
		},
		resolveCapabilityCeiling: (sessionId) => resolveCurrentSubagentCapabilityCeiling(sessionId),
	});
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		waitToolEnabled: waitToolConfig.enabled,
		handleScheduledRunAction: (params, ctx) => scheduledRunManager.handleToolCall(params, ctx),
		...(options.watchdog ? { watchdog: options.watchdog } : {}),
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		clarifier: options.clarifier,
		environmentProfile: options.environmentProfile,
	});
	executorExecute = executor.execute;

	const executeSubagentCollapsed = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext, origin: "model" | "user" = "model") => {
		if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
		return executor.execute(id, params, signal, onUpdate, ctx, origin);
	};

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executeSubagentCollapsed(id, params, signal, onUpdate, ctx, "user"),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (requestId, params, signal, ctx, onUpdate) =>
			executeSubagentCollapsed(requestId, params, signal, onUpdate, ctx, "user"),
		executeVersioned: (requestId, params, signal, ctx, onUpdate, origin) => {
			if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
			return executor.executeDelegated(requestId, params, signal, onUpdate, ctx, origin);
		},
	});
	const workflowTodoAdapter = createWorkflowTodoAdapter({
		events: pi.events,
		persistSnapshot: (data) => pi.appendEntry(WORKFLOW_TODO_SNAPSHOT_ENTRY_TYPE, data),
	});
	const workflowController = createWorkflowController({
		interaction: options.interaction,
		adapter: createWorkflowDelegationAdapter({
		events: pi.events,
		// Workflow-owned cross-provider fallback. Avoids DeepSeek account failures
		// cascading to every lane when the primary session model is on the same
		// provider. Only workflow delegation uses this; base Agent config is unchanged.
		fallbackModels: ["taqu/deepseek-v4-flash", "taqu/kimi-k2.7-code"],
	}),
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		hasTool: (name) => pi.getAllTools().some((tool) => tool.name === name),
		cancelWaitingChild: (childRunId) => state.foregroundControls.get(childRunId)?.interrupt?.() === true,
		applyTodoProjection: (projection, sessionId) => workflowTodoAdapter.apply(projection, sessionId),
		onRunChanged: () => baseCore.activityDock?.refresh(),
		defaultLanguage: config.workflowLanguage ?? "auto",
	});
	const workflowRuntime = createWorkflowRuntime({ pi, controller: workflowController });
	workflowCompletionUnsubscribe = pi.events.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, (data) => {
		if (state.lastUiContext) workflowController.handleForegroundCompletion(state.lastUiContext, data);
	});

	const rpcBridge = registerSubagentRpcBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) => executor.execute(id, params, signal, onUpdate, ctx),
		state,
	});

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const baseCore: ExtensionCore = {
		pi, state, config, executor, workflowController, workflowRuntime,
		workflowTodoAdapter, activityDock: undefined, rpcBridge, supervisorChannel,
		scheduledRunManager, completionNotifier, slashBridge, promptTemplateBridge, ensurePoller,
	};

	// Interactive-only render presentations, built from the caller's TUI wiring.
	const presentation = options.ui?.presentations(baseCore) ?? {};

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: buildSubagentToolDescription(config),
		parameters: SubagentParams,

		prepareArguments(args) {
			// Run friendly chain validation before pi-ai's raw TypeBox schema check
			// so the model sees which property is disallowed, what is allowed, and a
			// valid example instead of `chain.N: must not have additional properties`.
			validateChainInput(args);
			return args as never;
		},

		execute(id, params, signal, onUpdate, ctx) {
			return executeSubagentCollapsed(id, params, signal, onUpdate, ctx);
		},

		// The tool renderer remains live, but starts every delegated run in the
		// compact card state instead of inheriting a previous global expansion.
		...(presentation.subagentPresentation?.renderCall ? { renderCall: presentation.subagentPresentation.renderCall } : {}),
		...(presentation.subagentPresentation?.renderResult ? { renderResult: presentation.subagentPresentation.renderResult } : {}),
	};

	pi.registerTool(tool);
	registerWorkflowTool(pi, workflowController, presentation.workflowPresentation);
	registerWorkflowAssetsTool(pi, presentation.workflowAssetsPresentation);

	registerWaitTool(pi, state, waitToolConfig.enabled);

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) return;
		await drainOutstandingWork({ state, events: pi.events });
	});

	pi.on("agent_settled", (_event, ctx) => {
		workflowRuntime.handleAgentSettled(ctx);
	});

	const visibleControlNotices = new Set<string>();
	const controlEventHandler = (payload: unknown) => {
		handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
		});
	};
	const steeringNoticeHandler = (payload: unknown) => {
		handleSubagentSteeringNotice({ pi, state, details: payload as SubagentSteeringMessageDetails });
	};
	const asyncStartedHandler = (payload: unknown) => {
		handleStarted(payload);
		baseCore.activityDock?.refresh();
	};
	const asyncCompleteHandler = (payload: unknown) => {
		handleComplete(payload);
		baseCore.activityDock?.refresh();
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, asyncStartedHandler),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, asyncCompleteHandler),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
		pi.events.on(SUBAGENT_STEERING_NOTICE_EVENT, steeringNoticeHandler),
		rpcBridge.dispose,
	];

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "workflow" && event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		baseCore.activityDock?.setContext(ctx);
		baseCore.activityDock?.refresh();
		if (event.toolName === "subagent" && state.asyncJobs.size > 0) ensurePoller();
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext, recovering: boolean) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		state.parentSessionFile = ctx.sessionManager.getSessionFile();
		state.subagentSpawns = {
			sessionId: state.currentSessionId,
			count: 0,
			configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
			granted: 0,
			grantHistory: [],
		};
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		clearPendingForegroundControlNotices(state);
		for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
		state.cleanupTimers.clear();
		cleanupForegroundSteeringDirs(state);
		state.foregroundControls.clear();
		state.lastForegroundControlId = null;
		resetJobs(ctx);
		restoreActiveJobs(ctx);
		scheduledRunManager.bindSession(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		startResultWatcher();
		primeExistingResults({ triggerTurn: !recovering });
		baseCore.activityDock?.setContext(ctx);
	};

	pi.on("session_start", async (event, ctx) => {
		const recovering = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
		resetSessionState(ctx, recovering);
		rpcBridge.emitReady(ctx);
		supervisorChannel.start();
		await workflowRuntime.handleSessionStart(event, ctx);
	});

	pi.on("session_shutdown", () => {
		stopResultWatcher();
		state.currentSessionId = null;
		state.parentSessionFile = null;
		completionNotifier.dispose();
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		scheduledRunManager.stop();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		clearPendingForegroundControlNotices(state);
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		cleanupForegroundSteeringDirs(state);
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		supervisorChannel.dispose();
		baseCore.activityDock?.dispose();
		baseCore.activityDock = undefined;
		workflowCompletionUnsubscribe?.();
		workflowCompletionUnsubscribe = undefined;
		workflowRuntime.dispose();
		workflowTodoAdapter.dispose();
	});

	// Interactive-only Activity Dock controller + renderers + commands. The dock
	// assignment must happen before async/control events can fire so refresh works.
	if (options.ui) {
		options.ui.decorate(baseCore);
	}

	return baseCore;
}
