import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { registerWorkflowCommands } from "../../src/workflows/commands.ts";
import type { WorkflowController, WorkflowControllerResult } from "../../src/workflows/controller.ts";
import { parseWorkflowActionParams, registerWorkflowTool } from "../../src/workflows/tool.ts";
import { createWorkflowToolRenderer } from "../../src/tui/workflow-tool-renderer.ts";
import type { WorkflowRun } from "../../src/workflows/types.ts";

function run(): WorkflowRun {
	return {
		version: 0,
		id: "workflow-1",
		mode: "general",
		goal: "Goal",
		cwd: "/repo",
		sessionId: "session-1",
		branch: "main",
		status: "active",
		revision: 1,
		createdAt: Date.now() - 1_000,
		updatedAt: Date.now(),
		tasks: {},
		nodes: {},
		appliedEventIds: ["event-1"],
	};
}

function result(text = "ok"): WorkflowControllerResult {
	return { text, details: { run: run() } };
}

class FakePi {
	tools: ToolDefinition[] = [];
	commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	userMessages: string[] = [];
	messages: Array<{ message: unknown; options?: unknown }> = [];

	registerTool(tool: ToolDefinition): void {
		this.tools.push(tool);
	}

	registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void {
		this.commands.set(name, options);
	}

	sendUserMessage(content: string): void {
		this.userMessages.push(content);
	}

	sendMessage(message: unknown, options?: unknown): void {
		this.messages.push({ message, options });
	}
}

function fakeContext(): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: true,
		isIdle: () => true,
		abort() {},
		ui: { notify() {}, setToolsExpanded() {} },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
	} as unknown as ExtensionContext;
}

describe("workflow tool and commands", () => {
	it("registers a sequential workflow tool and routes validated actions to the controller", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = {
			current: () => undefined,
			async execute(params) {
				calls.push(params);
				return result("started");
			},
		};
		registerWorkflowTool(pi as unknown as ExtensionAPI, controller, createWorkflowToolRenderer());

		assert.equal(pi.tools.length, 1);
		const tool = pi.tools[0]!;
		assert.equal(tool.name, "workflow");
		assert.equal(tool.executionMode, "sequential");
		const parameters = tool.parameters as unknown as {
			properties: { workUnits: { items: { properties: Record<string, unknown> } } };
		};
		assert.deepEqual((parameters.properties.workUnits.items.properties.kind as { enum: string[] }).enum, ["research", "verification", "outline", "section-writer", "writer", "editor", "reviewer", "custom"]);
		assert.ok("agentSpec" in parameters.properties.workUnits.items.properties);
		assert.ok("dataContract" in parameters.properties.workUnits.items.properties);
		assert.ok("taskId" in parameters.properties.workUnits.items.properties);
		const validate = Compile(tool.parameters);
		const validPlan = {
			action: "apply_plan",
			tasks: [{ id: "research", label: "Research", order: 0 }],
			workUnits: [{
				id: "lane",
				taskId: "research",
				kind: "research",
				label: "Research lane",
				order: 0,
				dependsOn: [],
				agentSpec: {
					id: "lane-agent",
					baseAgent: "researcher",
					role: "Researcher",
					objective: "Collect evidence",
					instructions: "Return structured evidence.",
					context: "fresh",
				},
				dataContract: {
					version: 1,
					profile: "research",
					inputs: [],
					outputs: {
						result: {
							mediaType: "text/markdown",
							description: "Research dossier",
							storage: "artifact",
							required: true,
							classification: "internal",
						},
					},
				},
			}],
		};
		assert.equal(validate.Check(validPlan), true);
		const camelCasePortPlan = structuredClone(validPlan);
		camelCasePortPlan.workUnits[0]!.dataContract.outputs = {
			architectureMap: camelCasePortPlan.workUnits[0]!.dataContract.outputs.result!,
		};
		assert.equal(validate.Check(camelCasePortPlan), false);
		assert.equal(validate.Check({ action: "complete", nodeId: "editor", port: "document", digest: "abc123" }), true);
		for (const args of [
			{ action: "clarify", questions: [] },
			{ action: "set_brief", brief: {} },
			{ action: "set_outline", outline: { sections: [] } },
			{ action: "run_ready", concurrency: 3 },
			{ action: "status", runId: "a9ac6ae6" },
		] as const) {
			const renderedCall = tool.renderCall?.(
				args as never,
				{ fg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
			);
			assert.deepEqual(renderedCall?.render(100), []);
		}
		const toolResult = await tool.execute("call-1", { action: "start", mode: "general", goal: "Build it" }, undefined, undefined, fakeContext());
		assert.equal(toolResult.isError, undefined);
		assert.deepEqual(calls, [{ action: "start", mode: "general", goal: "Build it" }]);
		assert.equal(toolResult.content[0]?.type, "text");
	});

	it("aborts the root Pi turn only after a workflow tool stop succeeds", async () => {
		const pi = new FakePi();
		const order: string[] = [];
		const controller: WorkflowController = {
			current: () => run(),
			async execute(params) {
				order.push(`controller:${params.action}`);
				return result("stopped");
			},
		};
		const ctx = fakeContext();
		ctx.abort = () => order.push("abort");
		registerWorkflowTool(pi as unknown as ExtensionAPI, controller, createWorkflowToolRenderer());

		await pi.tools[0]!.execute("call-stop", { action: "stop", runId: "workflow-1" }, undefined, undefined, ctx);
		assert.deepEqual(order, ["controller:stop", "abort"]);

		order.length = 0;
		await pi.tools[0]!.execute("call-status", { action: "status", runId: "workflow-1" }, undefined, undefined, ctx);
		assert.deepEqual(order, ["controller:status"]);
	});

	it("does not abort the root Pi turn when workflow tool stop fails", async () => {
		const pi = new FakePi();
		let aborts = 0;
		const controller: WorkflowController = {
			current: () => run(),
			async execute() { throw new Error("stop failed"); },
		};
		const ctx = fakeContext();
		ctx.abort = () => { aborts++; };
		registerWorkflowTool(pi as unknown as ExtensionAPI, controller, createWorkflowToolRenderer());
		await assert.rejects(() => pi.tools[0]!.execute("call-stop-fail", { action: "stop", runId: "workflow-1" }, undefined, undefined, ctx), /stop failed/);
		assert.equal(aborts, 0);
	});

	it("forces workflow tool calls back to the compact host card state", async () => {
		const pi = new FakePi();
		let compacted = 0;
		const controller: WorkflowController = {
			current: () => undefined,
			async execute() { return result("started"); },
		};
		const ctx = fakeContext();
		ctx.ui.setToolsExpanded = () => { compacted++; };
		registerWorkflowTool(pi as unknown as ExtensionAPI, controller, createWorkflowToolRenderer());
		await pi.tools[0]!.execute("call-compact", { action: "start", mode: "general", goal: "Build it" }, undefined, undefined, ctx);
		assert.equal(compacted, 1);
	});

	it("renders the compact workflow card when the live snapshot provider throws", () => {
		const pi = new FakePi();
		const controller: WorkflowController = {
			current: () => undefined,
			async execute() { return result("unused"); },
		};
		registerWorkflowTool(pi as unknown as ExtensionAPI, controller, createWorkflowToolRenderer(() => {
			throw new TypeError("dock snapshot unavailable");
		}));
		const tool = pi.tools[0]!;
		const component = tool.renderResult?.(
			{ content: [{ type: "text", text: "RAW STATUS SHOULD NOT LEAK" }], details: { run: run() } },
			{ expanded: false, isPartial: false },
			{ fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as never,
		);
		const rendered = component?.render(120).join("\n") ?? "";
		assert.match(rendered, /Requirement: Goal/);
		assert.doesNotMatch(rendered, /workflow-1|RAW STATUS SHOULD NOT LEAK/);
	});

	it("keeps WorkflowDataContract V1 in model-supplied apply_plan work units", () => {
		const dataContract = {
			version: 1 as const,
			profile: "research" as const,
			inputs: [],
			outputs: {
				result: {
					mediaType: "text/markdown",
					description: "Research dossier",
					storage: "artifact" as const,
					required: true,
					classification: "internal" as const,
				},
			},
		};
		const parsed = parseWorkflowActionParams({
			action: "apply_plan",
			tasks: [{ id: "research", label: "Research", order: 0 }],
			workUnits: [{
				id: "lane",
				taskId: "research",
				kind: "research",
				label: "Research lane",
				order: 0,
				dependsOn: [],
				agentSpec: {
					id: "lane-agent",
					baseAgent: "researcher",
					role: "Researcher",
					objective: "Collect evidence",
					instructions: "Return structured evidence.",
					context: "fresh",
				},
				dataContract,
			}],
		});
		assert.equal(parsed.action, "apply_plan");
		assert.deepEqual(parsed.workUnits[0]?.dataContract, dataContract);
		assert.throws(() => parseWorkflowActionParams({
			action: "apply_plan",
			tasks: [{ id: "research", label: "Research", order: 0 }],
			workUnits: [{
				id: "lane",
				taskId: "research",
				kind: "research",
				label: "Research lane",
				order: 0,
				dependsOn: [],
				agentSpec: {
					id: "lane-agent",
					baseAgent: "researcher",
					role: "Researcher",
					objective: "Collect evidence",
					instructions: "Return structured evidence.",
					context: "fresh",
				},
			}],
		}), /must declare WorkflowDataContract version 1/);
	});

	it("keeps explicit run_ready retry and complete artifact fields", () => {
		assert.deepEqual(parseWorkflowActionParams({ action: "run_ready", runId: "workflow-1", concurrency: 1, nodeId: "failed-lane" }), {
			action: "run_ready",
			runId: "workflow-1",
			concurrency: 1,
			nodeId: "failed-lane",
		});
		assert.deepEqual(parseWorkflowActionParams({ action: "complete", runId: "workflow-1", nodeId: "editor", port: "document", digest: "abc123" }), {
			action: "complete",
			runId: "workflow-1",
			nodeId: "editor",
			port: "document",
			digest: "abc123",
		});
	});

	it("parses an explicit accepted-node supersession decision", () => {
		assert.deepEqual(parseWorkflowActionParams({
			action: "supersede",
			runId: "workflow-1",
			nodeId: "research-old",
			replacementNodeId: "research-v2",
			decision: "Replacement restores required search provenance.",
		}), {
			action: "supersede",
			runId: "workflow-1",
			nodeId: "research-old",
			replacementNodeId: "research-v2",
			decision: "Replacement restores required search provenance.",
		});
	});

	it("starts deep research directly and triggers the supervisor with hidden context", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = { current: () => undefined, async execute(params) { calls.push(params); return result(); } };
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);
		const ctx = fakeContext();

		await pi.commands.get("deep-research")?.handler("Compare agent runtimes", ctx);
		const aliasMessage = pi.messages.at(-1);
		await pi.commands.get("workflow")?.handler("run --mode deep-research Compare agent runtimes", ctx);
		const workflowMessage = pi.messages.at(-1);

		assert.deepEqual(aliasMessage, workflowMessage);
		assert.deepEqual(calls, [
			{ action: "start", mode: "deep-research", goal: "Compare agent runtimes" },
			{ action: "start", mode: "deep-research", goal: "Compare agent runtimes" },
		]);
		assert.equal(pi.userMessages.length, 0);
		const hidden = aliasMessage?.message as { content?: string; display?: boolean } | undefined;
		assert.equal(hidden?.display, false);
		assert.match(hidden?.content ?? "", /sole Supervisor/);
		assert.match(hidden?.content ?? "", /Compare agent runtimes/);
		assert.doesNotMatch(hidden?.content ?? "", /First read/);
		assert.deepEqual(aliasMessage?.options, { triggerTurn: true });
	});

	it("starts a deterministic Coding preset before triggering the supervisor", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = {
			current: () => undefined,
			async execute(params) {
				calls.push(params);
				return result(params.action === "apply_plan" ? "planned" : "started");
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);

		await pi.commands.get("coding")?.handler("full --lang zh 修复认证流程", fakeContext());

		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], { action: "start", mode: "general", codingStage: "full", goal: "修复认证流程", language: "zh" });
		const applied = calls[1] as { action?: string; runId?: string; tasks?: unknown[]; workUnits?: Array<{ id?: string }> };
		assert.equal(applied.action, "apply_plan");
		assert.equal(applied.runId, "workflow-1");
		assert.equal(applied.tasks?.length, 3);
		assert.deepEqual(applied.workUnits?.map((unit) => unit.id), [
			"coding-assumptions",
			"coding-plan",
			"coding-plan-check",
			"coding-build",
			"coding-review",
			"coding-integration",
			"coding-verify",
		]);
		const hidden = pi.messages.at(-1)?.message as { content?: string; display?: boolean; details?: { codingStage?: string } } | undefined;
		assert.equal(hidden?.display, false);
		assert.equal(hidden?.details?.codingStage, "full");
		assert.match(hidden?.content ?? "", /deterministic DAG/);
		assert.match(hidden?.content ?? "", /native approval/);
	});

	it("routes the swarm alias to a general supervisor workflow", async () => {
		const pi = new FakePi();
		const controller: WorkflowController = { current: () => undefined, async execute() { return result(); } };
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);

		await pi.commands.get("swarm")?.handler("Map the repository", fakeContext());
		const swarmMessage = pi.messages.at(-1);
		await pi.commands.get("workflow")?.handler("run Map the repository", fakeContext());
		const workflowMessage = pi.messages.at(-1);

		assert.deepEqual(swarmMessage, workflowMessage);
		const hidden = swarmMessage?.message as { content?: string } | undefined;
		assert.match(hidden?.content ?? "", /sole Supervisor/);
		assert.match(hidden?.content ?? "", /Map the repository/);
	});

	it("opens the native launch wizard when swarm has no arguments", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const selections = ["General workflow", "Chinese"];
		const controller: WorkflowController = {
			current: () => undefined,
			async execute(params) {
				calls.push(params);
				const workflow = run();
				workflow.goal = "分析仓库架构";
				workflow.language = "zh";
				return { text: "ok", details: { run: workflow } };
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);
		const ctx = {
			...fakeContext(),
			hasUI: true,
			ui: {
				notify() {},
				select: async () => selections.shift(),
				editor: async () => "分析仓库架构",
				confirm: async () => true,
			},
		} as unknown as ExtensionContext;

		await pi.commands.get("swarm")?.handler("", ctx);

		assert.deepEqual(calls, [{ action: "start", mode: "general", goal: "分析仓库架构", language: "zh" }]);
		assert.equal((pi.messages.at(-1)?.message as { display?: boolean }).display, false);
	});

	it("uses native confirmation before stopping a workflow", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const decisions = [false, true];
		let aborts = 0;
		const controller: WorkflowController = {
			current: () => run(),
			async execute(params) { calls.push(params); return result("stopped"); },
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);
		const ctx = {
			...fakeContext(),
			hasUI: true,
			abort: () => { aborts++; },
			ui: { notify() {}, confirm: async () => decisions.shift() ?? false },
		} as unknown as ExtensionContext;

		await pi.commands.get("workflow")?.handler("stop workflow-1", ctx);
		await pi.commands.get("workflow")?.handler("stop workflow-1", ctx);

		assert.deepEqual(calls, [{ action: "stop", runId: "workflow-1" }]);
		assert.equal(aborts, 1);
	});

	it("does not abort the root Pi turn when the slash stop action fails", async () => {
		const pi = new FakePi();
		let aborts = 0;
		const notices: string[] = [];
		const controller: WorkflowController = {
			current: () => run(),
			async execute() { throw new Error("durable stop failed"); },
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);
		const ctx = {
			...fakeContext(),
			hasUI: true,
			abort: () => { aborts++; },
			ui: { notify: (message: string) => notices.push(message), confirm: async () => true },
		} as unknown as ExtensionContext;
		await pi.commands.get("workflow")?.handler("stop workflow-1", ctx);
		assert.equal(aborts, 0);
		assert.deepEqual(notices, ["durable stop failed"]);
	});

	it("routes explicit language overrides and injects the resolved language contract", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = {
			current: () => undefined,
			async execute(params) {
				calls.push(params);
				const workflow = run();
				workflow.goal = "分析 AgentScope";
				workflow.language = "zh";
				return { text: "ok", details: { run: workflow } };
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);

		await pi.commands.get("deep-research")?.handler("--lang zh 分析 AgentScope", fakeContext());

		assert.deepEqual(calls, [{ action: "start", mode: "deep-research", goal: "分析 AgentScope", language: "zh" }]);
		const hidden = pi.messages.at(-1)?.message as { content?: string; details?: { language?: string } } | undefined;
		assert.match(hidden?.content ?? "", /Simplified Chinese/);
		assert.equal(hidden?.details?.language, "zh");
		assert.deepEqual(parseWorkflowActionParams({ action: "start", goal: "中文", language: "en" }), { action: "start", goal: "中文", language: "en" });
	});

	it("parses codingStage so the workflow tool can start the Coding preset", () => {
		assert.deepEqual(parseWorkflowActionParams({ action: "start", goal: "修复认证流程", codingStage: "full" }), { action: "start", goal: "修复认证流程", codingStage: "full" });
		assert.deepEqual(parseWorkflowActionParams({ action: "start", goal: "plan only", codingStage: "plan" }), { action: "start", goal: "plan only", codingStage: "plan" });
		// Unknown stage is dropped, not coerced.
		assert.deepEqual(parseWorkflowActionParams({ action: "start", goal: "bad", codingStage: "bogus" }), { action: "start", goal: "bad" });
	});

	it("parses writerNodeIds-only ownership for multi-section writers", () => {
		const parsed = parseWorkflowActionParams({
			action: "set_outline",
			outline: {
				version: 0, title: "Report", thesis: "Explicit ownership.", approval: "supervisor",
				sections: [
					{ id: "a", title: "A", objective: "A", questions: [], evidenceRequirements: [], targetWords: 100, writerNodeIds: ["writer-a"] },
					{ id: "b", title: "B", objective: "B", questions: [], evidenceRequirements: [], targetWords: 100, writerNodeIds: ["writer-a"] },
				],
			},
		});
		assert.deepEqual(parsed.action === "set_outline" ? parsed.outline.sections.map((section) => section.writerNodeIds) : [], [["writer-a"], ["writer-a"]]);
	});

	it("parses persisted research briefs and detailed outlines", () => {
		const brief = {
			version: 0 as const,
			audience: "Senior engineers",
			purpose: "Support an architecture decision",
			scope: "Runtime and operations",
			depth: "deep" as const,
			deliverable: "research-report" as const,
			targetWords: { min: 2000, max: 4000 },
			requiredTopics: ["Background", "Mechanism"],
			excludedTopics: [],
			constraints: ["Use accepted evidence only"],
			assumptions: [],
			clarification: "confirmed" as const,
		};
		const outline = {
			version: 0 as const,
			title: "Architecture report",
			thesis: "The evidence supports a durable workflow.",
			approval: "user" as const,
			sections: [
				{ id: "background", title: "Background", objective: "Explain context", questions: ["Why now?"], evidenceRequirements: ["Primary source"], targetWords: 900, writerNodeId: "section-a" },
				{ id: "mechanism", title: "Mechanism", objective: "Explain execution", questions: ["How does it work?"], evidenceRequirements: ["Technical source"], targetWords: 1100, writerNodeId: "section-b" },
			],
		};

		assert.deepEqual(parseWorkflowActionParams({ action: "set_brief", runId: "workflow-1", brief }), { action: "set_brief", runId: "workflow-1", brief });
		assert.deepEqual(parseWorkflowActionParams({ action: "set_outline", runId: "workflow-1", outline }), { action: "set_outline", runId: "workflow-1", outline });
	});

	it("parses native human-in-the-loop clarification questions", () => {
		const questions = [
			{ id: "audience", prompt: "目标读者？", options: ["架构师", "开发者"] },
			{ id: "depth", prompt: "研究深度？", options: [{ label: "标准", description: "覆盖官方架构与主要机制" }, { label: "源码级" }], multiple: true },
		];
		assert.deepEqual(parseWorkflowActionParams({ action: "clarify", runId: "workflow-1", questions }), {
			action: "clarify",
			runId: "workflow-1",
			questions: [
				{ id: "audience", prompt: "目标读者？", options: [{ label: "架构师" }, { label: "开发者" }], multiple: false },
				{ id: "depth", prompt: "研究深度？", options: [{ label: "标准", description: "覆盖官方架构与主要机制" }, { label: "源码级" }], multiple: true },
			],
		});
		assert.throws(
			() => parseWorkflowActionParams({ action: "clarify", questions: [{ ...questions[0], id: "duplicate" }, { ...questions[1], id: "duplicate" }] }),
			/Duplicate clarification question/,
		);
		assert.throws(
			() => parseWorkflowActionParams({ action: "clarify", questions: [{ id: "open", prompt: "请描述需求", options: [] }] }),
			/2-6 choices/,
		);
	});

	it("routes workflow status directly without starting a model turn", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = {
			current: () => run(),
			async execute(params) {
				calls.push(params);
				return result("Workflow status");
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);

		await pi.commands.get("workflow")?.handler("status workflow-1", fakeContext());
		assert.deepEqual(calls, [{ action: "status", runId: "workflow-1" }]);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.messages.length, 1);
	});

	it("routes workflow quality directly and parses the quality tool action", async () => {
		const pi = new FakePi();
		const calls: unknown[] = [];
		const controller: WorkflowController = {
			current: () => run(),
			async execute(params) {
				calls.push(params);
				return result("Quality report");
			},
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller);

		await pi.commands.get("workflow")?.handler("quality workflow-1", fakeContext());

		assert.deepEqual(calls, [{ action: "quality", runId: "workflow-1" }]);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.messages.length, 1);
		assert.deepEqual(parseWorkflowActionParams({ action: "quality", runId: "workflow-1" }), { action: "quality", runId: "workflow-1" });
	});

	it("points board and inspect at the Activity Dock instead of a legacy board", async () => {
		const pi = new FakePi();
		const opened: Array<string | undefined> = [];
		const controller: WorkflowController = {
			current: () => run(),
			async execute() { return result("Workflow status"); },
		};
		registerWorkflowCommands(pi as unknown as ExtensionAPI, controller, {
			openActivity: (_ctx, runId) => { opened.push(runId); },
		});
		const ctx = fakeContext();

		await pi.commands.get("workflow")?.handler("board", ctx);
		await pi.commands.get("workflow")?.handler("inspect workflow-1", ctx);

		assert.deepEqual(opened, [undefined, "workflow-1"]);
	});

	it("parses explicit uncertainty and conflict decisions", () => {
		assert.deepEqual(parseWorkflowActionParams({
			action: "record_decision",
			runId: "workflow-1",
			decisionKind: "accepted_uncertainty",
			target: "Is recovery cross-branch safe?",
			rationale: "No public evidence is available.",
		}), {
			action: "record_decision",
			runId: "workflow-1",
			decisionKind: "accepted_uncertainty",
			target: "Is recovery cross-branch safe?",
			rationale: "No public evidence is available.",
		});
	});
});
