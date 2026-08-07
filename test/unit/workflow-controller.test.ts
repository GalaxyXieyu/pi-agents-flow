import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowDelegationAdapter } from "../../src/workflows/delegation-adapter.ts";
import { createWorkflowBinding } from "../../src/workflows/branch-binding.ts";
import { buildCodingWorkflowPlan } from "../../src/workflows/coding-preset.ts";
import { createWorkflowController, WORKFLOW_BINDING_ENTRY_TYPE, type WorkflowController } from "../../src/workflows/controller.ts";
import { workflowProfileForKind } from "../../src/workflows/plan-rules.ts";
import { createWorkflowStore } from "../../src/workflows/store.ts";
import type { WorkflowResult, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function envelope(summary: string): WorkflowResult {
	return { version: 1, summary: { text: summary, covers: [], omissions: [], confidence: "high" }, outputs: { result: { kind: "value", value: summary } }, diagnostics: { gaps: [], conflicts: [], warnings: [] }, recommendations: [], evidence: { findings: [] } };
}

function completedResponse(requestId: string, ownerRunId: string, nodeId: string) {
	return {
		version: 2 as const,
		requestId,
		ownerRunId,
		nodeId,
		status: "completed" as const,
		result: { kind: "structured" as const, value: envelope(`completed ${nodeId}`) },
	};
}

function planNode(id: string, kind: WorkflowWorkUnitPlan["kind"] = "research", dependsOn: string[] = []): WorkflowWorkUnitPlan {
	const profile = workflowProfileForKind(kind);
	const outputName = profile === "writer" ? "document" : profile === "reviewer" ? "review" : "result";
	const baseAgent = kind === "verification"
		? "research-verifier"
		: kind === "outline"
			? "research-architect"
			: kind === "section-writer"
				? "research-section-writer"
				: kind === "writer"
					? "research-writer"
					: kind === "editor"
						? "research-editor"
						: kind === "reviewer"
							? "research-reviewer"
							: "researcher";
	return {
		id,
		taskId: "task-main",
		kind,
		label: id,
		order: 0,
		dependsOn,
		agentSpec: {
			id: `agent-`,
			baseAgent,
			role: kind,
			objective: `Complete ${id}`,
			instructions: "Return structured evidence.",
			context: "fresh",
		},
		dataContract: { version: 1, profile, inputs: [], outputs: { [outputName]: { mediaType: "application/json", description: outputName, storage: "artifact", required: true, classification: "internal" } } },
	};
}

function fakeContext(cwd: string, entries: unknown[]): ExtensionContext {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
}

describe("workflow controller", () => {
	it("resolves and persists workflow language from the goal or explicit override", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-language-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let runNumber = 0;
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => `workflow-language-${++runNumber}`,
			now: () => runNumber,
			resolveBranch: () => "main",
			defaultLanguage: "auto",
		});
		const ctx = fakeContext(cwd, entries);

		const detected = await controller.execute({ action: "start", goal: "分析这个插件" }, ctx);
		assert.equal(detected.details.run.language, "zh");
		const event = JSON.parse(fs.readFileSync(path.join(cwd, ".pi-agents-flow", "workflows", detected.details.run.id, "events.jsonl"), "utf-8").trim()) as { language?: string };
		assert.equal(event.language, "zh");

		const overridden = await controller.execute({ action: "start", goal: "分析这个插件", language: "en" }, ctx);
		assert.equal(overridden.details.run.language, "en");
	});

	it("persists the configured node-attempt ceiling when the workflow starts", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-attempt-config-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: { async run() { throw new Error("unused"); } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-attempt-config",
			now: () => 1,
			resolveBranch: () => "main",
			maxNodeAttempts: 5,
		});
		const ctx = fakeContext(cwd, entries);

		const started = await controller.execute({ action: "start", goal: "Persist attempts" }, ctx);
		assert.equal(started.details.run.maxNodeAttempts, 5);
		assert.equal(controller.recover(ctx)?.maxNodeAttempts, 5);
	});

	it("runs the complete supervisor-owned workflow loop and writes the delivery artifact", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				return {
					ok: true,
					response: {
						version: 2,
						requestId: attempt.requestId,
						ownerRunId: run.id,
						nodeId: node.id,
						status: "completed",
						result: { kind: "structured", value: envelope(`completed ${node.id}`) },
					},
				};
			},
		};
		let timestamp = 10;
		const controller = createWorkflowController({
			adapter,
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-1",
			now: () => timestamp++,
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);

		const started = await controller.execute({ action: "start", mode: "general", goal: "Produce a report" }, ctx);
		assert.equal(started.details.run.id, "workflow-1");
		await controller.execute({ action: "apply_plan", runId: "workflow-1", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		const executed = await controller.execute({ action: "run_ready", runId: "workflow-1" }, ctx);
		assert.equal(executed.details.run.nodes["research-a"]?.status, "completed");
		assert.match(executed.text, /research-a/);
		assert.match(executed.text, /completed research-a/);

		const evaluated = await controller.execute({ action: "evaluate", runId: "workflow-1" }, ctx);
		assert.equal(evaluated.details.evaluation?.completedAwaitingDecision, 1);
		assert.equal(evaluated.details.evaluation?.readyToComplete, false);
		assert.match(evaluated.text, /completed research-a/);
		const nodeResult = await controller.execute({ action: "get_result", runId: "workflow-1", nodeId: "research-a" }, ctx);
		assert.match(nodeResult.text, /"text": "completed research-a"/);

		await controller.execute({ action: "accept", runId: "workflow-1", nodeId: "research-a", decision: "Evidence accepted." }, ctx);
		const acceptedRun = evaluated.details.run;
		const artifact = acceptedRun.nodes["research-a"]?.outputs?.result;
		assert.ok(artifact && artifact.kind === "artifact", "research-a should have an artifact output");
		const digest = artifact?.kind === "artifact" ? artifact.artifact.sha256 : "";
		const completed = await controller.execute({ action: "complete", runId: "workflow-1", nodeId: "research-a", port: "result", digest }, ctx);
		assert.equal(completed.details.run.status, "completed");
		assert.ok(completed.details.finalPath);
		assert.ok(entries.length >= 5);
		assert.ok(entries.every((entry) => entry.customType === WORKFLOW_BINDING_ENTRY_TYPE));
		assert.equal((entries.at(-1)?.data as { revision?: number }).revision, completed.details.run.revision);
	});

	it("requires native approval before accepting the full Coding plan gate", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-coding-approval-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const decisions = [false, true];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return {
						ok: true,
						response: completedResponse(attempt.requestId, run.id, node.id),
					};
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-coding-approval",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = {
			...fakeContext(cwd, entries),
			hasUI: true,
			ui: { confirm: async () => decisions.shift() ?? false },
		} as unknown as ExtensionContext;
		const plan = buildCodingWorkflowPlan("full");

		await controller.execute({ action: "start", goal: "Implement safely", codingStage: "full" }, ctx);
		await controller.execute({ action: "apply_plan", ...plan }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "coding-assumptions", decision: "Assumptions accepted." }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "coding-plan", decision: "Plan accepted for review." }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);

		await assert.rejects(
			controller.execute({ action: "accept", nodeId: "coding-plan-check", decision: "Plan verified." }, ctx),
			/approval was declined/,
		);
		const declined = controller.current(ctx);
		assert.equal(declined?.nodes["coding-plan-check"]?.status, "completed");
		assert.equal(declined?.nodes["coding-build"]?.status, "pending");

		const approved = await controller.execute({ action: "accept", nodeId: "coding-plan-check", decision: "User approved implementation." }, ctx);
		assert.equal(approved.details.run.nodes["coding-plan-check"]?.status, "accepted");
		assert.equal(approved.details.run.nodes["coding-build"]?.status, "ready");
	});

	it("requires the same native approval when a replacement supersedes the full Coding plan gate", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-coding-supersede-approval-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const decisions = [false, true];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-coding-supersede-approval",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = {
			...fakeContext(cwd, entries),
			hasUI: true,
			ui: { confirm: async () => decisions.shift() ?? false },
		} as unknown as ExtensionContext;
		const plan = buildCodingWorkflowPlan("full");

		await controller.execute({ action: "start", goal: "Implement safely", codingStage: "full" }, ctx);
		await controller.execute({ action: "apply_plan", ...plan }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "coding-assumptions", decision: "Assumptions accepted." }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "coding-plan", decision: "Plan accepted for review." }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		const gate = plan.workUnits.find((unit) => unit.id === "coding-plan-check");
		assert.ok(gate);
		const replacement: WorkflowWorkUnitPlan = {
			...gate,
			id: "coding-plan-check-v2",
			label: "Verify revised implementation plan",
			dependsOn: ["coding-plan"],
			dataContract: {
				...gate.dataContract,
				annotations: { "pi-agents-flow/coding-preapproval-readonly@1": { required: true } },
				inputs: gate.dataContract.inputs.map((binding) => ({ ...binding, from: binding.from.map((source) => ({ ...source })) })),
			},
		};
		await controller.execute({ action: "apply_plan", tasks: plan.tasks, workUnits: [replacement] }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: replacement.id, decision: "Replacement verification accepted." }, ctx);

		await assert.rejects(
			controller.execute({ action: "supersede", nodeId: "coding-plan-check", replacementNodeId: replacement.id, decision: "Use revised verification." }, ctx),
			/approval was declined/,
		);
		const declined = controller.current(ctx);
		assert.equal(declined?.nodes["coding-plan-check"]?.supersededBy, undefined);
		assert.equal(declined?.nodes["coding-build"]?.status, "pending");

		const approved = await controller.execute({ action: "supersede", nodeId: "coding-plan-check", replacementNodeId: replacement.id, decision: "User approved revised verification." }, ctx);
		assert.equal(approved.details.run.nodes["coding-plan-check"]?.supersededBy, replacement.id);
		assert.equal(approved.details.run.nodes["coding-build"]?.status, "ready");
	});

	it("rejects implementation and writable planning repairs before full Coding approval", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-coding-preapproval-plan-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: { async run() { throw new Error("unused"); } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-coding-preapproval-plan",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		const plan = buildCodingWorkflowPlan("full");
		await controller.execute({ action: "start", goal: "Implement safely", codingStage: "full" }, ctx);
		await controller.execute({ action: "apply_plan", ...plan }, ctx);

		const build = plan.workUnits.find((unit) => unit.id === "coding-build");
		const planning = plan.workUnits.find((unit) => unit.id === "coding-plan");
		assert.ok(build && planning);
		await assert.rejects(
			controller.execute({
				action: "apply_plan",
				tasks: plan.tasks,
				workUnits: [{ ...build, id: "coding-build-bypass" }],
			}, ctx),
			/cannot be added before approval/,
		);
		await assert.rejects(
			controller.execute({
				action: "apply_plan",
				tasks: plan.tasks,
				workUnits: [{ ...planning, id: "coding-plan-repair", agentSpec: { ...planning.agentSpec, denyTools: [] } }],
			}, ctx),
			/must deny bash\/edit\/write/,
		);
		await assert.rejects(
			controller.execute({
				action: "apply_plan",
				tasks: plan.tasks,
				workUnits: [{
					...planning,
					id: "coding-plan-repair-unmarked",
					dataContract: { ...planning.dataContract, annotations: {} },
				}],
			}, ctx),
			/require effective read-only preflight/,
		);
	});

	it("enforces the persisted Coding completion source", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-coding-completion-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-coding-completion",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		const plan = buildCodingWorkflowPlan("build");
		await controller.execute({ action: "start", goal: "Implement approved request", codingStage: "build" }, ctx);
		await controller.execute({ action: "apply_plan", ...plan }, ctx);
		for (const nodeId of ["coding-build", "coding-review", "coding-build-verify"]) {
			await controller.execute({ action: "run_ready" }, ctx);
			await controller.execute({ action: "accept", nodeId, decision: `${nodeId} accepted.` }, ctx);
		}
		const run = controller.current(ctx);
		const buildOutput = run?.nodes["coding-build"]?.outputs?.result;
		const verifierOutput = run?.nodes["coding-build-verify"]?.outputs?.result;
		assert.ok(buildOutput?.kind === "artifact" && verifierOutput?.kind === "artifact");
		await assert.rejects(
			controller.execute({ action: "complete", nodeId: "coding-build", port: "result", digest: buildOutput.artifact.sha256 }, ctx),
			/must complete from 'coding-build-verify\.result'/,
		);
		const completed = await controller.execute({ action: "complete", nodeId: "coding-build-verify", port: "result", digest: verifierOutput.artifact.sha256 }, ctx);
		assert.equal(completed.details.run.status, "completed");
	});

	it("applies todo projections through the runtime adapter instead of asking the model", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-todo-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const projections: number[] = [];
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			applyTodoProjection: (projection) => {
				projections.push(projection.operations.length);
				return { supported: true, applied: projection.operations.length };
			},
			hasTool: (name) => name === "todo",
			createRunId: () => "workflow-todo",
			now: () => 1,
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);

		const started = await controller.execute({ action: "start", goal: "Track this" }, ctx);
		const planned = await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);

		// Phase-level operations only. Adding one research node swaps the general-mode
		// execution phase for a research phase rather than appending a per-subagent
		// entry, so the count stays at the number of live phases.
		assert.deepEqual(projections, [3, 3]);
		assert.doesNotMatch(started.text, /call the existing todo tool/i);
		assert.doesNotMatch(planned.text, /call the existing todo tool/i);
	});

	it("refuses to complete deep research without accepted editor and reviewer nodes", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-gate-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-deep",
			now: () => 10,
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", mode: "deep-research", goal: "Research" }, ctx);

		await assert.rejects(
			controller.execute({ action: "complete", runId: "workflow-deep", finalMarkdown: "# Incomplete" }, ctx),
			/accepted editor and reviewer/i,
		);
	});

	it("requires a research brief before planning and an outline before document production", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-document-plan-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-document-plan",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", mode: "deep-research", goal: "Research durable orchestration" }, ctx);

		const blockedBeforeBrief = await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		assert.match(blockedBeforeBrief.text, /clarify.*set_brief/i);
		assert.deepEqual(blockedBeforeBrief.details.run.nodes, {});
		const brief = {
			version: 0 as const,
			audience: "Senior engineers",
			purpose: "Support an architecture decision",
			scope: "Runtime and recovery",
			depth: "deep" as const,
			deliverable: "research-report" as const,
			targetWords: { min: 1500, max: 3000 },
			requiredTopics: ["Background", "Mechanism"],
			excludedTopics: [],
			constraints: [],
			assumptions: [],
			clarification: "confirmed" as const,
		};
		const briefResult = await controller.execute({ action: "set_brief", brief }, ctx);
		assert.deepEqual(briefResult.details.run.researchBrief, brief);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		const blockedBeforeOutline = await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("section-a", "section-writer", ["research-a"])] }, ctx);
		assert.match(blockedBeforeOutline.text, /set_outline/i);
		assert.equal(blockedBeforeOutline.details.run.nodes["section-a"], undefined);

		const outline = {
			version: 0 as const,
			title: "Durable orchestration",
			thesis: "Explicit workflow contracts improve research quality.",
			approval: "supervisor" as const,
			sections: [
				{ id: "background", title: "Background", objective: "Explain context", questions: ["Why?"], evidenceRequirements: ["Primary sources"], targetWords: 700, writerNodeId: "section-a" },
				{ id: "mechanism", title: "Mechanism", objective: "Explain execution", questions: ["How?"], evidenceRequirements: ["Technical sources"], targetWords: 800, writerNodeId: "section-b" },
			],
		};
		const outlineResult = await controller.execute({ action: "set_outline", outline }, ctx);
		assert.deepEqual(outlineResult.details.run.documentOutline, outline);
		const planned = await controller.execute({
			action: "apply_plan",
			tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [
				planNode("section-a", "section-writer", ["research-a"]),
				planNode("section-b", "section-writer", ["research-a"]),
				planNode("editor", "editor", ["section-a", "section-b"]),
				planNode("reviewer", "reviewer", ["editor"]),
			],
		}, ctx);
		assert.equal(planned.details.run.nodes.editor?.kind, "editor");
	});

	it("requires real user approval before persisting a user-owned outline", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-outline-review-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let review: { cancelled: boolean; approved: boolean; feedback?: string } = { cancelled: false, approved: false, feedback: "提高 PoC 路线权重" };
		let receivedOutline: unknown;
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-outline-review",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		const base = fakeContext(cwd, entries);
		const ctx = {
			...base,
			hasUI: true,
			ui: {
				async custom() {
					receivedOutline = outline;
					return review;
				},
				notify() {},
			},
		} as unknown as ExtensionContext;
		await controller.execute({ action: "start", mode: "deep-research", goal: "比较企业 Agent 框架" }, ctx);
		await controller.execute({ action: "set_brief", brief: {
			version: 0,
			audience: "架构师",
			purpose: "技术选型",
			scope: "架构与工程化",
			depth: "deep",
			deliverable: "research-report",
			targetWords: { min: 2000, max: 5000 },
			requiredTopics: [],
			excludedTopics: [],
			constraints: [],
			assumptions: [],
			clarification: "confirmed",
		} }, ctx);
		const outline = {
			version: 0 as const,
			title: "企业 Agent 框架选型",
			thesis: "按场景选择。",
			approval: "user" as const,
			sections: [
				{ id: "background", title: "背景", objective: "解释背景", questions: ["为什么？"], evidenceRequirements: ["官方资料"], targetWords: 700, writerNodeId: "writer-background" },
				{ id: "decision", title: "决策", objective: "给出路线", questions: ["如何选择？"], evidenceRequirements: ["场景证据"], targetWords: 900, writerNodeId: "writer-decision" },
			],
		};

		const rejected = await controller.execute({ action: "set_outline", outline }, ctx);
		assert.deepEqual(receivedOutline, outline);
		assert.equal(rejected.details.run.documentOutline, undefined);
		assert.equal(rejected.details.outlineReview?.feedback, "提高 PoC 路线权重");
		assert.match(rejected.text, /not recorded/i);

		review = { cancelled: false, approved: true, feedback: undefined };
		const approved = await controller.execute({ action: "set_outline", outline }, ctx);
		assert.deepEqual(approved.details.run.documentOutline, outline);
		assert.equal(approved.details.outlineReview, undefined);
	});

	it("repairs rejected Section Writer ownership only after renewed user approval", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-outline-repair-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let reviewCount = 0;
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return node.id.endsWith("-r2")
						? { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) }
						: { ok: true, response: { version: 2, requestId: attempt.requestId, ownerRunId: run.id, nodeId: node.id, status: "failed", error: "invalid envelope" } };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-outline-repair",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		const base = fakeContext(cwd, entries);
		const ctx = {
			...base,
			hasUI: true,
			ui: {
				async custom() {
					reviewCount++;
					return { cancelled: false, approved: true };
				},
				notify() {},
			},
		} as unknown as ExtensionContext;
		await controller.execute({ action: "start", mode: "deep-research", goal: "Repair an approved outline" }, ctx);
		await controller.execute({ action: "set_brief", brief: {
			version: 0,
			audience: "Engineers",
			purpose: "Verify recovery",
			scope: "Writer ownership",
			depth: "standard",
			deliverable: "research-report",
			targetWords: { min: 1000, max: 2000 },
			requiredTopics: [],
			excludedTopics: [],
			constraints: [],
			assumptions: [],
			clarification: "confirmed",
		} }, ctx);
		const outline = {
			version: 0 as const,
			title: "Repairable outline",
			thesis: "Rejected writers can be replaced without changing approved content.",
			approval: "user" as const,
			sections: [
				{ id: "a", title: "Background", objective: "Explain context", questions: ["Why?"], evidenceRequirements: ["Primary sources"], targetWords: 500, writerNodeId: "section-a" },
				{ id: "b", title: "Mechanism", objective: "Explain repair", questions: ["How?"], evidenceRequirements: ["Implementation evidence"], targetWords: 500, writerNodeId: "section-b" },
			],
		};
		await controller.execute({ action: "set_outline", outline }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("section-a", "section-writer"), planNode("section-b", "section-writer")] }, ctx);
		await controller.execute({ action: "run_ready", concurrency: 2 }, ctx);
		await controller.execute({ action: "reject", nodeId: "section-a", decision: "Replace invalid output." }, ctx);
		await controller.execute({ action: "reject", nodeId: "section-b", decision: "Replace invalid output." }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("section-a-r2", "section-writer"), planNode("section-b-r2", "section-writer")] }, ctx);

		const repaired = await controller.execute({
			action: "set_outline",
			outline: {
				...outline,
				sections: [
					{ ...outline.sections[0], writerNodeId: "section-a-r2" },
					{ ...outline.sections[1], writerNodeId: "section-b-r2" },
				],
			},
		}, ctx);

		assert.equal(reviewCount, 2);
		assert.deepEqual(repaired.details.run.documentOutline?.sections.map((section) => section.writerNodeId), ["section-a-r2", "section-b-r2"]);
	});

	it("collects Deep Research clarification through native Pi dialogs before the brief", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-clarify-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let receivedQuestions: unknown;
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-clarify",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		const base = fakeContext(cwd, entries);
		const ctx = {
			...base,
			hasUI: true,
			ui: {
				async custom(_factory: unknown) {
					receivedQuestions = questions;
					return {
						cancelled: false,
						answers: [
							{ id: "audience", prompt: "目标读者？", answer: "技术负责人和架构师", selections: ["技术负责人和架构师"], wasCustom: false },
							{ id: "scenario", prompt: "选型背景？", answer: "新项目；同时覆盖旧系统迁移", selections: ["新项目", "同时覆盖旧系统迁移"], wasCustom: true },
						],
					};
				},
				notify() {},
			},
		} as unknown as ExtensionContext;
		await controller.execute({ action: "start", mode: "deep-research", goal: "分析两个框架的区别" }, ctx);

		const questions = [
			{ id: "audience", prompt: "目标读者？", options: [{ label: "技术负责人和架构师" }, { label: "一线开发者" }], multiple: false },
			{ id: "scenario", prompt: "选型背景？", options: [{ label: "新项目" }, { label: "现有系统迁移" }], multiple: true },
		];
		const clarified = await controller.execute({
			action: "clarify",
			questions,
		}, ctx);

		assert.deepEqual(receivedQuestions, questions);
		assert.equal(clarified.details.clarification?.cancelled, false);
		assert.deepEqual(clarified.details.clarification?.round?.answers.map((answer) => answer.answer), [
			"技术负责人和架构师",
			"新项目；同时覆盖旧系统迁移",
		]);
		assert.equal(clarified.details.run.clarifications?.length, 1);
		assert.match(clarified.text, /call set_brief/i);
		assert.equal(clarified.details.run.researchBrief, undefined);
	});

	it("cancels running nodes on stop and keeps stopped workflows terminal", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-stop-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let started = false;
		const adapter: WorkflowDelegationAdapter = {
			run(run, node, attempt, signal) {
				started = true;
				return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({
					ok: true,
					response: {
						version: 2,
						requestId: attempt.requestId,
						ownerRunId: run.id,
						nodeId: node.id,
						status: "cancelled",
						error: "cancelled by supervisor",
					},
				}), { once: true }));
			},
		};
		const controller = createWorkflowController({
			adapter,
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-stop",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Stop it" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		const running = controller.execute({ action: "run_ready" }, ctx);
		while (!started) await new Promise((resolve) => setImmediate(resolve));

		const stopped = await controller.execute({ action: "stop" }, ctx);
		const settled = await running;

		assert.equal(stopped.details.run.status, "stopped");
		assert.equal(settled.details.run.status, "stopped");
		assert.equal(settled.details.run.nodes["research-a"]?.status, "cancelled");
		assert.equal(settled.details.run.nodes["research-a"]?.attempts[0]?.status, "cancelled");
		await assert.rejects(controller.execute({ action: "resume" }, ctx), /only paused workflows or stopped workflows with a new ready repair plan can resume/i);
	});

	it("restarts a stopped workflow only after a new repair plan is added", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-restart-repair-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let firstStarted = false;
		let calls = 0;
		const controller = createWorkflowController({
			adapter: {
				run(run, workflowNode, attempt, signal) {
					calls++;
					if (workflowNode.id === "research-a") {
						firstStarted = true;
						return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({
							ok: true,
							response: {
								version: 2,
								requestId: attempt.requestId,
								ownerRunId: run.id,
								nodeId: workflowNode.id,
								status: "cancelled",
								error: "cancelled by supervisor",
							},
						}), { once: true }));
					}
					return Promise.resolve({ ok: true, response: completedResponse(attempt.requestId, run.id, workflowNode.id) });
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-restart-repair",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Repair after stop" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		const running = controller.execute({ action: "run_ready" }, ctx);
		while (!firstStarted) await new Promise((resolve) => setImmediate(resolve));
		await controller.execute({ action: "stop" }, ctx);
		await running;

		const planned = await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("repair-a")] }, ctx);
		assert.equal(planned.details.run.status, "stopped");
		assert.deepEqual(planned.details.run.repairPlanNodeIdsAfterStop, ["repair-a"]);
		assert.equal(planned.details.run.nodes["research-a"]?.status, "cancelled");
		assert.equal(planned.details.run.nodes["repair-a"]?.status, "ready");

		const resumed = await controller.execute({ action: "resume" }, ctx);
		assert.equal(resumed.details.run.status, "active");
		assert.deepEqual(resumed.details.run.repairPlanNodeIdsAfterStop, ["repair-a"]);
		assert.equal(resumed.details.run.nodes["research-a"]?.status, "cancelled");
		assert.equal(resumed.details.run.nodes["repair-a"]?.status, "completed");
		assert.equal(calls, 2);
	});

	it("runs a ready repair without implicitly retrying an old failed node", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-repair-only-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const calls = new Map<string, number>();
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					const call = (calls.get(node.id) ?? 0) + 1;
					calls.set(node.id, call);
					if (node.id === "research-old" && call === 1) return { ok: false, stage: "transport", error: "old failure" };
					return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-repair-only",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Run one repair" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-old")] }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-new")] }, ctx);

		const repaired = await controller.execute({ action: "run_ready" }, ctx);
		assert.equal(repaired.details.run.nodes["research-new"]?.status, "completed");
		assert.equal(repaired.details.run.nodes["research-old"]?.status, "failed");
		assert.equal(calls.get("research-old"), 1);

		const retried = await controller.execute({ action: "run_ready", nodeId: "research-old" }, ctx);
		assert.equal(retried.details.run.nodes["research-old"]?.status, "completed");
		assert.equal(calls.get("research-old"), 2);
	});

	it("revives a stopped workflow when an accepted replacement supersedes an accepted node", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-supersede-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-supersede",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Repair accepted evidence" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-old"), planNode("research-v2")] }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "research-old", decision: "Initial evidence accepted." }, ctx);
		await controller.execute({ action: "accept", nodeId: "research-v2", decision: "Corrected evidence accepted." }, ctx);
		await controller.execute({ action: "stop" }, ctx);

		const repaired = await controller.execute({
			action: "supersede",
			nodeId: "research-old",
			replacementNodeId: "research-v2",
			decision: "The replacement restores required provenance.",
		}, ctx);

		assert.equal(repaired.details.run.status, "active");
		assert.equal(repaired.details.run.nodes["research-old"]?.status, "superseded");
		assert.equal(repaired.details.run.nodes["research-old"]?.supersededBy, "research-v2");
		assert.equal(repaired.details.run.nodes["research-v2"]?.status, "accepted");
	});

	it("supersedes a failed node with an accepted same-kind replacement", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-failed-supersede-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return node.id === "research-old"
						? { ok: false, stage: "transport", error: "old failure" }
						: { ok: true, response: completedResponse(attempt.requestId, run.id, node.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-failed-supersede",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Replace failed evidence" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-old"), planNode("research-v2")] }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		await controller.execute({ action: "accept", nodeId: "research-v2", decision: "Replacement accepted." }, ctx);

		const superseded = await controller.execute({ action: "supersede", nodeId: "research-old", replacementNodeId: "research-v2", decision: "Accepted replacement covers the failed node." }, ctx);
		assert.equal(superseded.details.run.nodes["research-old"]?.status, "superseded");
		assert.equal(superseded.details.run.nodes["research-old"]?.supersededBy, "research-v2");
		assert.equal(superseded.details.run.nodes["research-old"]?.attempts[0]?.error, "old failure");
	});

	it("hands an exhausted node back to the Supervisor instead of starting a fourth attempt", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-exhausted-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let calls = 0;
		const controller = createWorkflowController({
			adapter: { async run() { calls++; return { ok: false, stage: "transport", error: `failure ${calls}` }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-exhausted",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
			maxNodeAttempts: 3,
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Stop after three" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		await controller.execute({ action: "run_ready" }, ctx);
		for (let index = 0; index < 2; index++) await controller.execute({ action: "run_ready", nodeId: "research-a" }, ctx);

		await assert.rejects(
			controller.execute({ action: "run_ready", nodeId: "research-a" }, ctx),
			/reached its 3-attempt ceiling.*inspect retained output.*reopen it.*replace it/i,
		);
		const status = await controller.execute({ action: "status" }, ctx);
		assert.equal(calls, 3);
		assert.equal(status.details.evaluation?.exhausted, 1);
		assert.match(status.text, /supervisor_intervention/);
		assert.match(status.text, /Inspect retained structured output and artifacts/i);
	});

	it("pauses only new scheduling and actively runs ready nodes on resume", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-resume-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let calls = 0;
		const controller = createWorkflowController({
			adapter: {
				async run(run, workflowNode, attempt) {
					calls++;
					return { ok: true, response: completedResponse(attempt.requestId, run.id, workflowNode.id) };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-resume",
			now: (() => { let value = 1; return () => value++; })(),
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Resume it" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);

		const paused = await controller.execute({ action: "pause" }, ctx);
		assert.equal(paused.details.run.status, "paused");
		assert.equal(paused.details.run.nodes["research-a"]?.status, "ready");
		assert.equal(calls, 0);

		const resumed = await controller.execute({ action: "resume" }, ctx);
		assert.equal(resumed.details.run.status, "active");
		assert.equal(resumed.details.run.nodes["research-a"]?.status, "completed");
		assert.equal(calls, 1);
	});

	it("recovers an orphaned running attempt as a retryable failure after reload", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-recover-"));
		tempDirs.push(cwd);
		const store = createWorkflowStore({ rootDir: path.join(cwd, ".pi-agents-flow", "workflows") });
		store.create({ id: "workflow-recover", mode: "general", goal: "Recover", cwd, sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-recover", { id: "plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] });
		const running = store.append("workflow-recover", {
			id: "started",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-1", number: 1, startedAt: 3 },
		});
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [{
			type: "custom",
			customType: WORKFLOW_BINDING_ENTRY_TYPE,
			data: createWorkflowBinding(running),
		}];
		const controller = createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			now: () => 10,
			resolveBranch: () => "main",
		});

		const recovered = controller.recover(fakeContext(cwd, entries));

		assert.equal(recovered?.nodes["research-a"]?.status, "failed");
		assert.match(recovered?.nodes["research-a"]?.attempts[0]?.error ?? "", /runtime restarted/i);
		assert.equal((entries.at(-1)?.data as { revision?: number }).revision, recovered?.revision);
	});

	it("reconciles an early detached completion into the original attempt without launching a replacement", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-detached-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let controller!: WorkflowController;
		let ctx!: ExtensionContext;
		let calls = 0;
		const adapter: WorkflowDelegationAdapter = {
			async run(run, node, attempt) {
				calls++;
				controller.handleForegroundCompletion(ctx, {
					id: "child-early-1:0",
					runId: "child-early-1",
					source: "foreground",
					mode: "single",
					agent: node.agentSpec.baseAgent,
					success: true,
					summary: "completed after supervisor reply",
					exitCode: 0,
					state: "complete",
					timestamp: 50,
					cwd,
					sessionId: "session-1",
					taskIndex: 0,
					structuredOutput: envelope("completed after supervisor reply"),
					model: "mock/model",
					launchContractDigest: "digest-early-1",
					usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
					progressSummary: { toolCount: 4, tokens: 5, durationMs: 6 },
				});
				return {
					ok: true,
					response: {
						version: 2,
						requestId: attempt.requestId,
						ownerRunId: run.id,
						nodeId: node.id,
						status: "detached",
						runId: "child-early-1",
						launchContractDigest: "digest-early-1",
					},
				};
			},
		};
		controller = createWorkflowController({
			adapter,
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-detached",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Wait for one child" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);

		const completed = await controller.execute({ action: "run_ready" }, ctx);
		assert.equal(completed.details.run.nodes["research-a"]?.status, "completed");
		assert.equal(completed.details.run.nodes["research-a"]?.attempts.length, 1);
		assert.equal(completed.details.run.nodes["research-a"]?.attempts[0]?.status, "completed");
		assert.equal(completed.details.run.nodes["research-a"]?.attempts[0]?.childRunId, "child-early-1");
		assert.equal(completed.details.run.nodes["research-a"]?.result?.summary.text, "completed after supervisor reply");

		await controller.execute({ action: "run_ready" }, ctx);
		assert.equal(calls, 1);
	});

	it("recovers a completed detached attempt from durable metadata after controller reload", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-waiting-recover-"));
		tempDirs.push(cwd);
		const rootDir = path.join(cwd, ".pi-agents-flow", "workflows");
		const metadataPath = path.join(cwd, "child-meta.json");
		const structuredOutputPath = path.join(cwd, "child-output.json");
		const store = createWorkflowStore({ rootDir });
		store.create({ id: "workflow-waiting", mode: "general", goal: "Recover waiting", cwd, sessionId: "session-1", branch: "main", at: 1 });
		store.append("workflow-waiting", { id: "plan", type: "workflow.plan_applied", at: 2, tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] });
		store.append("workflow-waiting", {
			id: "started",
			type: "node.started",
			at: 3,
			nodeId: "research-a",
			attempt: { attemptId: "research-a:1", requestId: "request-1", number: 1, startedAt: 3 },
		});
		const waiting = store.append("workflow-waiting", {
			id: "waiting",
			type: "node.waiting",
			at: 4,
			nodeId: "research-a",
			attemptId: "research-a:1",
			reason: "waiting for supervisor reply",
			childRunId: "child-reload-1",
			launchContractDigest: "digest-reload-1",
			structuredOutputPath,
			metadataPath,
		});
		fs.writeFileSync(metadataPath, JSON.stringify({ exitCode: -2, timestamp: 5 }), "utf-8");
		fs.writeFileSync(structuredOutputPath, JSON.stringify(envelope("recovered durable result")), "utf-8");
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [{
			type: "custom",
			customType: WORKFLOW_BINDING_ENTRY_TYPE,
			data: createWorkflowBinding(waiting),
		}];
		const createController = () => createWorkflowController({
			adapter: { async run() { return { ok: false, stage: "transport", error: "unused" }; } },
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			now: () => 10,
			resolveBranch: () => "main",
		});
		const ctx = fakeContext(cwd, entries);

		assert.equal(createController().recover(ctx)?.nodes["research-a"]?.status, "waiting");
		fs.writeFileSync(metadataPath, JSON.stringify({
			exitCode: 0,
			timestamp: 20,
			model: "mock/model",
			launchContractDigest: "digest-reload-1",
		}), "utf-8");
		const recovered = createController().recover(ctx);

		assert.equal(recovered?.nodes["research-a"]?.status, "completed");
		assert.equal(recovered?.nodes["research-a"]?.attempts.length, 1);
		assert.equal(recovered?.nodes["research-a"]?.attempts[0]?.status, "completed");
		assert.equal(recovered?.nodes["research-a"]?.result?.summary.text, "recovered durable result");
	});

	it("salvages valid structured output from a failed foreground completion before retrying", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-failed-foreground-salvage-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		let controller!: ReturnType<typeof createWorkflowController>;
		let ctx!: ExtensionContext;
		controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					controller.handleForegroundCompletion(ctx, {
						id: "completion-failed-with-output",
						runId: "child-failed-with-output",
						source: "foreground",
						mode: "single",
						agent: "researcher",
						success: false,
						summary: "provider connection failed after output",
						exitCode: 1,
						state: "failed",
						timestamp: 20,
						cwd,
						taskIndex: 0,
						structuredOutput: envelope("salvaged foreground result"),
						artifactPaths: { inputPath: "/tmp/input", outputPath: "/tmp/output", jsonlPath: "/tmp/events", transcriptPath: "/tmp/transcript", metadataPath: "/tmp/meta" },
					});
					return { ok: true, response: { version: 2, requestId: attempt.requestId, ownerRunId: run.id, nodeId: node.id, status: "detached", runId: "child-failed-with-output" } };
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-failed-foreground-salvage",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
		});
		ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Keep valid output" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);

		const completed = await controller.execute({ action: "run_ready" }, ctx);
		const attempt = completed.details.run.nodes["research-a"]?.attempts[0];

		assert.equal(completed.details.run.nodes["research-a"]?.status, "completed");
		assert.equal(completed.details.run.nodes["research-a"]?.result?.summary.text, "salvaged foreground result");
		assert.equal(attempt?.recoveredFromError, "provider connection failed after output");
		assert.ok(attempt?.artifactPaths?.includes("/tmp/output"));
	});

	it("interrupts and cancels a waiting detached child when the workflow stops", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-waiting-stop-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const cancelledChildren: string[] = [];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return {
						ok: true,
						response: {
							version: 2,
							requestId: attempt.requestId,
							ownerRunId: run.id,
							nodeId: node.id,
							status: "detached",
							runId: "child-stop-1",
						},
					};
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-stop-waiting",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
			cancelWaitingChild: (childRunId) => {
				cancelledChildren.push(childRunId);
				return true;
			},
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Stop waiting child" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a")] }, ctx);
		assert.equal((await controller.execute({ action: "run_ready" }, ctx)).details.run.nodes["research-a"]?.status, "waiting");

		const stopped = await controller.execute({ action: "stop" }, ctx);
		assert.deepEqual(cancelledChildren, ["child-stop-1"]);
		assert.equal(stopped.details.run.status, "stopped");
		assert.equal(stopped.details.run.nodes["research-a"]?.status, "cancelled");
		assert.match(stopped.details.run.nodes["research-a"]?.attempts[0]?.error ?? "", /interrupt delivered/i);
	});

	it("cancels one waiting workflow node without stopping its siblings or the workflow", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-controller-node-cancel-"));
		tempDirs.push(cwd);
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
		const cancelledChildren: string[] = [];
		const controller = createWorkflowController({
			adapter: {
				async run(run, node, attempt) {
					return {
						ok: true,
						response: {
							version: 2,
							requestId: attempt.requestId,
							ownerRunId: run.id,
							nodeId: node.id,
							status: "detached",
							runId: `child-${node.id}`,
						},
					};
				},
			},
			appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
			createRunId: () => "workflow-node-cancel",
			now: (() => { let timestamp = 1; return () => timestamp++; })(),
			resolveBranch: () => "main",
			cancelWaitingChild: (childRunId) => {
				cancelledChildren.push(childRunId);
				return true;
			},
		});
		const ctx = fakeContext(cwd, entries);
		await controller.execute({ action: "start", goal: "Cancel one node" }, ctx);
		await controller.execute({ action: "apply_plan", tasks: [{ id: "task-main", label: "Main", order: 0 }], workUnits: [planNode("research-a"), planNode("research-b")] }, ctx);
		const waiting = await controller.execute({ action: "run_ready", concurrency: 2 }, ctx);
		assert.equal(waiting.details.run.nodes["research-a"]?.status, "waiting");
		assert.equal(waiting.details.run.nodes["research-b"]?.status, "waiting");

		const cancelled = await controller.execute({ action: "cancel_node", nodeId: "research-a" }, ctx);
		assert.equal(cancelled.details.run.status, "active");
		assert.equal(cancelled.details.run.nodes["research-a"]?.status, "cancelled");
		assert.equal(cancelled.details.run.nodes["research-b"]?.status, "waiting");
		assert.deepEqual(cancelledChildren, ["child-research-a"]);
	});
});
