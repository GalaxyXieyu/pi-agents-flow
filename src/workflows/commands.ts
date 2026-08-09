import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildCodingWorkflowPlan, type CodingStage } from "./coding-preset.ts";
import type { WorkflowController } from "./controller.ts";
import {
	compositionsDir,
	formatCompositionSummary,
	listCompositions,
	loadComposition,
	parseCompositionParamArgs,
	renderComposition,
	saveComposition,
} from "./composition-store.ts";
import { workflowLanguageInstruction, workflowRunLanguage, type WorkflowLanguageMode } from "./language.ts";
import { parseWorkflowActionParams } from "./tool.ts";
import type { WorkflowMode } from "./types.ts";

const WORKFLOW_SUPERVISOR_CONTEXT = "workflow-supervisor-context";

function supervisorContext(mode: WorkflowMode, goal: string, runId: string, language: "zh" | "en"): string {
	return [
		"[PI AGENTS FLOW SUPERVISOR CONTEXT]",
		`Run ${runId} already exists in ${mode} mode for this goal: ${goal}`,
		"You are the sole Supervisor. Do not call workflow start and do not read package skill or reference files; the required operating contract is included here.",
		workflowLanguageInstruction(language),
		"Create node labels, roles, objectives, and instructions in the resolved workflow language. Require every child ResultEnvelope summary, finding, gap, conflict, and recommendation to use that language.",
		"WorkflowDataContract V1 names are lowercase only and must match ^[a-z][a-z0-9._-]{0,63}$; use architecture-map or architecture_map, never camelCase such as architectureMap. The contract profile must match kind: research/verification -> research, section-writer/writer/editor -> writer, reviewer -> reviewer, outline/custom -> generic.",
		mode === "deep-research"
			? [
				"Do not apply the execution DAG yet. First establish the research contract.",
				"If audience, purpose, scope, required depth, or output expectations are materially ambiguous, call workflow clarify with 3-5 concise high-value choice questions. Give each question 2-6 clear choices with optional short descriptions and put the recommended/default choice first.",
				"Set multiple=true only when combining choices is meaningful. Pi's native questionnaire always provides Other for user-written context. Do not print the questionnaire as ordinary assistant text.",
				"After clarify returns answers, immediately call set_brief with clarification=confirmed. Never call apply_plan before set_brief succeeds.",
				"When the request is already explicit, infer only low-risk details and call set_brief with clarification=inferred. After user answers, call set_brief with clarification=confirmed.",
				"If terminology, scope, or source availability is uncertain, apply only a small reconnaissance/outline plan first: kind=research nodes using baseAgent=researcher, followed only when an actual outline artifact is needed by kind=outline using baseAgent=research-architect. Do not label ordinary reconnaissance as kind=outline. Evaluate and accept those results before presenting the detailed outline.",
				"Design a detailed outline whose sections each define objective, questions, evidence requirements, target words, and a section-writer node owner. Call set_outline with approval=user so Pi opens the inline approval/revision form; do not print a standalone confirmation request. If the user requests changes, revise the outline and call set_outline again. Use approval=supervisor only when the user explicitly requested immediate execution without outline review.",
				"Only after brief and outline are persisted, apply a typed DAG with at least three independent kind=research/baseAgent=researcher lanes, at least two parallel kind=section-writer/baseAgent=research-section-writer nodes, one kind=editor/baseAgent=research-editor, and one kind=reviewer/baseAgent=research-reviewer. Verification uses research-verifier; outline uses research-architect. The editor depends on every Section Writer; the Reviewer depends on the editor.",
			].join(" ")
			: "Immediately apply a typed DAG of bounded AgentSpecs with explicit dependencies, precise objectives, fresh or fork context, and structured result schemas.",
		"Run independent ready nodes in parallel. Evaluate every completed result, then explicitly accept or reject it with a concrete rationale.",
		"Add targeted verification or repair nodes for evidence gaps, conflicts, or failures. Complete only after deterministic gates pass and write the final Markdown artifact.",
		"Use the workflow tool for every state transition. Do not narrate routine transitions before tool calls; call the next required workflow action directly.",
	].join("\n\n");
}

function codingSupervisorContext(stage: CodingStage, goal: string, runId: string, language: "zh" | "en"): string {
	const stageContract = stage === "plan"
		? "Run the existing assumptions -> plan -> plan-check DAG. Evaluate and explicitly accept or reject every completed node. After coding-plan-check is accepted, complete from coding-plan.result so the delivered artifact is the verified implementation plan. Do not implement code."
		: stage === "build"
			? "Run the existing implementation -> code-review -> goal-verification DAG. The implementation request is already approved. Evaluate and explicitly accept or reject all results, repair named blockers when needed, then complete from coding-build-verify.result."
			: stage === "verify"
				? "Run the existing parallel code-review and integration-check nodes, then goal verification. This is read-only verification. Evaluate and explicitly accept or reject all results, then complete from coding-verify.result."
				: "Run the existing plan -> approval-gated implementation -> parallel code-review and integration-check -> goal-verification DAG. Evaluate planning nodes first. Before accepting coding-plan-check, present the verified plan to the user; the accept transition opens native approval and implementation must remain locked until the user confirms. Then run and evaluate implementation and all quality gates. Complete only from coding-verify.result after the final verifier is accepted.";
	return [
		"[PI AGENTS FLOW CODING WORKFLOW CONTEXT]",
		`Coding workflow ${runId} already exists for stage '${stage}' and goal: ${goal}`,
		"You are the sole Supervisor. The complete deterministic DAG and WorkflowDataContract V1 bindings are already persisted. Do not call workflow start, workflow_assets, or apply_plan unless a completed result reveals one precise repair node that could not have been known earlier.",
		workflowLanguageInstruction(language),
		stageContract,
		"Call workflow run_ready, evaluate completed results, and accept or reject each result with concrete evidence. Child completion is not acceptance. Preserve one writer. Use targeted repair only for a named gap or failed gate.",
		"Use the workflow tool for every transition. Do not narrate routine transitions before tool calls.",
	].join("\n\n");
}

function parseRun(raw: string, initialMode: WorkflowMode = "general", allowMode = true): { mode: WorkflowMode; language?: WorkflowLanguageMode; goal: string } {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	let mode: WorkflowMode = initialMode;
	let language: WorkflowLanguageMode | undefined;
	const goal: string[] = [];
	for (let index = 0; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--mode") {
			if (!allowMode) throw new Error("--mode is not supported by this alias.");
			const requested = words[++index];
			if (requested !== "general" && requested !== "deep-research") throw new Error("--mode must be general or deep-research.");
			mode = requested;
			continue;
		}
		if (word.startsWith("--mode=")) {
			if (!allowMode) throw new Error("--mode is not supported by this alias.");
			const requested = word.slice("--mode=".length);
			if (requested !== "general" && requested !== "deep-research") throw new Error("--mode must be general or deep-research.");
			mode = requested;
			continue;
		}
		if (word === "--lang" || word === "--language") {
			const requested = words[++index];
			if (requested !== "auto" && requested !== "zh" && requested !== "en") throw new Error("--lang must be auto, zh, or en.");
			language = requested;
			continue;
		}
		if (word.startsWith("--lang=") || word.startsWith("--language=")) {
			const requested = word.slice(word.indexOf("=") + 1);
			if (requested !== "auto" && requested !== "zh" && requested !== "en") throw new Error("--lang must be auto, zh, or en.");
			language = requested;
			continue;
		}
		goal.push(word);
	}
	if (goal.length === 0) throw new Error("Workflow goal must not be blank.");
	return { mode, ...(language ? { language } : {}), goal: goal.join(" ") };
}

function display(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({ customType: "workflow-status", content, display: true });
}

interface WorkflowLaunchDraft {
	mode: WorkflowMode;
	language: WorkflowLanguageMode;
	goal: string;
}

interface CodingLaunchDraft {
	stage: CodingStage;
	language: WorkflowLanguageMode;
	goal: string;
}

async function promptWorkflowLaunch(
	ctx: ExtensionCommandContext,
	options: { mode?: WorkflowMode; allowMode?: boolean } = {},
): Promise<WorkflowLaunchDraft | undefined> {
	let mode = options.mode ?? "general";
	if (options.allowMode !== false && options.mode === undefined) {
		const selectedMode = await ctx.ui.select("Choose a Pi Agents Flow workflow", [
			"General workflow",
			"Deep research",
		]);
		if (!selectedMode) return undefined;
		mode = selectedMode === "Deep research" ? "deep-research" : "general";
	}

	const selectedLanguage = await ctx.ui.select("Workflow language", [
		"Auto detect",
		"Chinese",
		"English",
	]);
	if (!selectedLanguage) return undefined;
	const language: WorkflowLanguageMode = selectedLanguage === "Chinese"
		? "zh"
		: selectedLanguage === "English"
			? "en"
			: "auto";
	const goal = await ctx.ui.editor(
		mode === "deep-research" ? "Deep research question" : "Workflow goal",
		"",
	);
	if (!goal?.trim()) return undefined;
	const confirmed = await ctx.ui.confirm(
		mode === "deep-research" ? "Start deep research?" : "Start Pi Agents Flow workflow?",
		`${goal.trim()}\n\nLanguage: ${selectedLanguage}`,
	);
	if (!confirmed) return undefined;
	return { mode, language, goal: goal.trim() };
}

async function promptCodingLaunch(ctx: ExtensionCommandContext): Promise<CodingLaunchDraft | undefined> {
	const selectedStage = await ctx.ui.select("Coding workflow stage", [
		"Full - plan, approve, build, and verify",
		"Plan - analyze and verify a plan",
		"Build - implement an approved request and verify it",
		"Verify - inspect integration and goal delivery",
	]);
	if (!selectedStage) return undefined;
	const stage: CodingStage = selectedStage.startsWith("Plan")
		? "plan"
		: selectedStage.startsWith("Build")
			? "build"
			: selectedStage.startsWith("Verify")
				? "verify"
				: "full";
	const selectedLanguage = await ctx.ui.select("Workflow language", ["Auto detect", "Chinese", "English"]);
	if (!selectedLanguage) return undefined;
	const language: WorkflowLanguageMode = selectedLanguage === "Chinese" ? "zh" : selectedLanguage === "English" ? "en" : "auto";
	const goal = await ctx.ui.editor("Coding goal", "");
	if (!goal?.trim()) return undefined;
	const confirmed = await ctx.ui.confirm("Start Coding workflow?", `${goal.trim()}\n\nStage: ${stage}\nLanguage: ${selectedLanguage}`);
	return confirmed ? { stage, language, goal: goal.trim() } : undefined;
}

function parseCoding(raw: string): { stage: CodingStage; language?: WorkflowLanguageMode; goal: string } {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	const stage = words.shift();
	if (stage !== "plan" && stage !== "build" && stage !== "verify" && stage !== "full") {
		throw new Error("Usage: /coding <plan|build|verify|full> [--lang auto|zh|en] <goal>");
	}
	const parsed = parseRun(words.join(" "), "general", false);
	return { stage, ...(parsed.language ? { language: parsed.language } : {}), goal: parsed.goal };
}

async function startWorkflow(
	pi: ExtensionAPI,
	controller: WorkflowController,
	mode: WorkflowMode,
	goal: string,
	language: WorkflowLanguageMode | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const started = await controller.execute({ action: "start", mode, goal, ...(language ? { language } : {}) }, ctx);
	const resolvedLanguage = workflowRunLanguage(started.details.run);
	pi.sendMessage({
		customType: WORKFLOW_SUPERVISOR_CONTEXT,
		content: supervisorContext(mode, goal, started.details.run.id, resolvedLanguage),
		display: false,
		details: { runId: started.details.run.id, mode, goal, language: resolvedLanguage },
	}, ctx.isIdle()
		? { triggerTurn: true }
		: { triggerTurn: true, deliverAs: "followUp" });
}

async function startCodingWorkflow(
	pi: ExtensionAPI,
	controller: WorkflowController,
	draft: CodingLaunchDraft,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const started = await controller.execute({ action: "start", mode: "general", codingStage: draft.stage, goal: draft.goal, language: draft.language }, ctx);
	const plan = buildCodingWorkflowPlan(draft.stage);
	let applied: Awaited<ReturnType<WorkflowController["execute"]>>;
	try {
		applied = await controller.execute({ action: "apply_plan", runId: started.details.run.id, ...plan }, ctx);
	} catch (error) {
		await controller.execute({ action: "stop", runId: started.details.run.id }, ctx).catch(() => undefined);
		throw error;
	}
	const resolvedLanguage = workflowRunLanguage(applied.details.run);
	pi.sendMessage({
		customType: WORKFLOW_SUPERVISOR_CONTEXT,
		content: codingSupervisorContext(draft.stage, draft.goal, applied.details.run.id, resolvedLanguage),
		display: false,
		details: { runId: applied.details.run.id, mode: "general", codingStage: draft.stage, goal: draft.goal, language: resolvedLanguage },
	}, ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" });
}

async function directAction(
	pi: ExtensionAPI,
	controller: WorkflowController,
	action: "status" | "quality" | "pause" | "resume" | "stop",
	runId: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		if (action === "stop" && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Stop workflow?",
				`Stop ${runId ? `workflow ${runId}` : "the current workflow"}. Running nodes will be cancelled and the workflow cannot be resumed.`,
			);
			if (!confirmed) return;
		}
		const result = await controller.execute({ action, ...(runId ? { runId } : {}) }, ctx);
		display(pi, result.text);
		// Workflow cancellation and the root Pi operation use separate abort
		// controllers. Stop the current model turn only after the durable workflow
		// state and user-visible confirmation have been written.
		if (action === "stop") ctx.abort();
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

interface WorkflowCommandOptions {
	openActivity?: (ctx: ExtensionCommandContext, runId?: string) => Promise<void> | void;
}

export function registerWorkflowCommands(pi: ExtensionAPI, controller: WorkflowController, options: WorkflowCommandOptions = {}): void {
	pi.registerCommand("coding", {
		description: "Run a durable Coding workflow: /coding <plan|build|verify|full> [--lang auto|zh|en] <goal>",
		handler: async (rawArgs, ctx) => {
			try {
				let draft: CodingLaunchDraft | undefined;
				if (rawArgs.trim()) {
					const parsed = parseCoding(rawArgs);
					draft = { ...parsed, language: parsed.language ?? "auto" };
				} else draft = await promptCodingLaunch(ctx);
				if (!draft) return;
				await startCodingWorkflow(pi, controller, draft, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("workflow", {
		description: "Run or control a dynamic workflow: /workflow run [--mode deep-research] [--lang auto|zh|en] <goal>",
			handler: async (rawArgs, ctx) => {
			const trimmed = rawArgs.trim();
			if (!trimmed) {
				await directAction(pi, controller, "status", undefined, ctx);
				return;
			}
			const separator = trimmed.indexOf(" ");
			const action = separator === -1 ? trimmed : trimmed.slice(0, separator);
			const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
				if (action === "run") {
					try {
						const parsed = rest
							? parseRun(rest)
							: await promptWorkflowLaunch(ctx);
						if (!parsed) return;
						await startWorkflow(pi, controller, parsed.mode, parsed.goal, parsed.language, ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
				if (action === "status" || action === "quality" || action === "pause" || action === "resume" || action === "stop") {
				await directAction(pi, controller, action, rest || undefined, ctx);
					return;
				}
				if (action === "board" || action === "inspect") {
					if (options.openActivity) {
						await options.openActivity(ctx, rest || undefined);
						return;
					}
					ctx.ui.notify("Activity Board is unavailable in this context.", "error");
					return;
				}
				ctx.ui.notify("Usage: /workflow run [--mode deep-research] [--lang auto|zh|en] <goal> | status [runId] | quality [runId] | activity | pause [runId] | resume [runId] | stop [runId]", "error");
		},
	});

	pi.registerCommand("deep-research", {
		description: "Run a dynamic Deep Research workflow",
			handler: async (rawArgs, ctx) => {
				if (!rawArgs.trim()) {
					const draft = await promptWorkflowLaunch(ctx, { mode: "deep-research", allowMode: false });
					if (draft) await startWorkflow(pi, controller, draft.mode, draft.goal, draft.language, ctx);
					return;
			}
			try {
				const parsed = parseRun(rawArgs, "deep-research", false);
				await startWorkflow(pi, controller, "deep-research", parsed.goal, parsed.language, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("swarm", {
		description: "Run a general dynamic workflow with the Pi Agents Flow supervisor",
			handler: async (rawArgs, ctx) => {
				if (!rawArgs.trim()) {
					const draft = await promptWorkflowLaunch(ctx);
					if (draft) await startWorkflow(pi, controller, draft.mode, draft.goal, draft.language, ctx);
					return;
			}
			try {
				const parsed = parseRun(rawArgs, "general", false);
				await startWorkflow(pi, controller, "general", parsed.goal, parsed.language, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("composition", {
		description: "Reuse a saved node plan: /composition list | show <name> | save <name> [description] | run <name> [--param k=v ...]",
		handler: async (rawArgs, ctx) => {
			const trimmed = rawArgs.trim();
			const separator = trimmed.indexOf(" ");
			const action = separator === -1 ? trimmed : trimmed.slice(0, separator);
			const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
			try {
				if (action === "" || action === "list") {
					const names = listCompositions(ctx.cwd);
					display(pi, names.length > 0
						? `Compositions (${names.length})\n${names.map((entry) => `- ${entry}`).join("\n")}`
						: `No compositions saved in ${compositionsDir(ctx.cwd)}.`);
					return;
				}
				if (action === "show") {
					if (!rest) throw new Error("Usage: /composition show <name>");
					display(pi, formatCompositionSummary(loadComposition(ctx.cwd, rest)));
					return;
				}
				if (action === "save") {
					const words = rest.split(/\s+/).filter(Boolean);
					const name = words.shift();
					if (!name) throw new Error("Usage: /composition save <name> [description]");
					const run = controller.current(ctx);
					if (!run) throw new Error("No workflow is bound to this session branch.");
					const workUnits = Object.values(run.nodes);
					if (workUnits.length === 0) throw new Error(`Workflow ${run.id} has no work units to save.`);
					const description = words.join(" ");
					const saved = saveComposition(ctx.cwd, {
						name,
						...(description ? { description } : {}),
						params: [],
						tasks: Object.values(run.tasks).map((task) => ({ ...task })),
						workUnits: workUnits.map((node) => ({
							id: node.id,
							taskId: node.taskId,
							kind: node.kind,
							label: node.label,
							order: node.order,
							dependsOn: [...node.dependsOn],
							// Flattened to plain data: templates are persisted as JSON and
							// re-validated on load, so they carry no typed spec identity.
							agentSpec: Object.fromEntries(Object.entries(node.agentSpec)),
						})),
					});
					display(pi, `Saved composition '${name}' with ${workUnits.length} work unit${workUnits.length === 1 ? "" : "s"} to ${saved}.\nConcrete values were kept as-is. Edit the file to introduce {{param}} placeholders and declare them under params.`);
					return;
				}
				if (action === "run") {
					const words = rest.split(/\s+/).filter(Boolean);
					const name = words.shift();
					if (!name) throw new Error("Usage: /composition run <name> [--param k=v ...]");
					const paramArgs: string[] = [];
					for (let index = 0; index < words.length; index++) {
						const word = words[index]!;
						if (word === "--param") {
							const pair = words[++index];
							if (!pair) throw new Error("--param requires name=value.");
							paramArgs.push(pair);
							continue;
						}
						if (word.startsWith("--param=")) {
							paramArgs.push(word.slice("--param=".length));
							continue;
						}
						throw new Error(`Unexpected argument '${word}'; use --param name=value.`);
					}
					const template = loadComposition(ctx.cwd, name);
					const rendered = renderComposition(template, parseCompositionParamArgs(paramArgs));
					// Reuse the workflow tool's parser so a hand-edited template is held to
					// exactly the same AgentSpec contract as a model-supplied apply_plan.
					const applyParams = parseWorkflowActionParams({ action: "apply_plan", tasks: rendered.tasks, workUnits: rendered.workUnits });
					const result = await controller.execute(applyParams, ctx);
					const skippedNote = rendered.skipped.length > 0
						? `\nSkipped ${rendered.skipped.length} node${rendered.skipped.length === 1 ? "" : "s"}: ${rendered.skipped.map((entry) => `${entry.id} (${entry.enableIf})`).join(", ")}`
						: "";
					display(pi, `${result.text}${skippedNote}`);
					return;
				}
				throw new Error("Usage: /composition list | show <name> | save <name> [description] | run <name> [--param k=v ...]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
