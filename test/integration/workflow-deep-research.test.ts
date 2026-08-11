import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import type { WorkflowControllerDetails } from "../../src/workflows/controller.ts";
import { workflowProfileForKind } from "../../src/workflows/plan-rules.ts";
import type { WorkflowResult, WorkflowNodeKind, WorkflowWorkUnitPlan } from "../../src/workflows/types.ts";
import { createEventBus, createMockPi, type MockPi } from "../support/helpers.ts";

function outputPortForKind(kind: WorkflowNodeKind): "result" | "document" | "review" {
	if (kind === "section-writer" || kind === "writer" || kind === "editor") return "document";
	if (kind === "reviewer") return "review";
	return "result";
}

function envelope(
	summary: string,
	options: { gap?: boolean; conflict?: boolean; findings?: boolean; port?: "result" | "document" | "review"; release?: boolean } = {},
): WorkflowResult {
	const sourceUrl = `https://example.test/${summary.toLowerCase().replace(/\s+/g, "-")}`;
	const port = options.port ?? "result";
	return {
		version: 1,
		summary: { text: summary, covers: [], omissions: [], confidence: "high" },
		outputs: { [port]: { kind: "value", value: summary } },
		diagnostics: {
			gaps: options.gap ? [{ question: "Does reload preserve the workflow branch binding?", reason: "Needs a targeted recovery check." }] : [],
			conflicts: options.conflict ? [{ statement: "QuickJS is required for V0", alternatives: ["required", "not required"], evidence: ["https://example.test/architecture"] }] : [],
			warnings: [],
		},
		recommendations: [],
		evidence: {
			findings: options.findings === false ? [] : [{
				claim: `${summary} is supported.`,
				evidence: [{ title: "Primary source", url: sourceUrl, kind: "primary", quote: `${summary} direct evidence.` }],
				confidence: "high",
			}],
			search: { queries: [`${summary} primary source`], fetchedUrls: [sourceUrl], droppedSources: [] },
		},
		...(options.release ? { review: { verdict: "pass" as const }, extensions: { release: { release: true, rationale: "Integration reviewer approved the final editor document." } } } : {}),
	};
}

function node(id: string, kind: WorkflowNodeKind, baseAgent: string, dependsOn: string[] = [], taskId = "task-research"): WorkflowWorkUnitPlan {
	const outputPort = outputPortForKind(kind);
	return {
		id,
		taskId,
		kind,
		label: id,
		order: 0,
		dependsOn,
		agentSpec: {
			id: `agent-${id}`,
			baseAgent,
			role: kind,
			objective: `Complete ${id}`,
			instructions: "Use the assigned evidence lane and return a WorkflowResult through structured_output.",
			context: "fresh",
			skills: ["deep-research"],
		},
		dataContract: {
			version: 1,
			profile: workflowProfileForKind(kind),
			inputs: [],
			outputs: {
				[outputPort]: {
					mediaType: outputPort === "document" ? "text/markdown" : "application/json",
					description: `${kind} output`,
					storage: "artifact",
					required: true,
					classification: "internal",
				},
			},
		},
	};
}

describe("dynamic Deep Research workflow integration", () => {
	let mockPi: MockPi;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	let originalAgentDir: string | undefined;

	before(() => {
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	it("runs brief, outline, research fanout, section writing, editing, review, and delivery through the registered Pi tool", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-e2e-"));
		const isolatedHome = path.join(cwd, "home");
		process.env.HOME = isolatedHome;
		process.env.USERPROFILE = isolatedHome;
		process.env.PI_CODING_AGENT_DIR = path.join(isolatedHome, ".pi", "agent");
		mockPi.reset();
		mockPi.onCall({ output: "research a", structuredOutput: envelope("Architecture", { gap: true, conflict: true }), delay: 50 });
		mockPi.onCall({ output: "research b", structuredOutput: envelope("Safety"), delay: 50 });
		mockPi.onCall({ output: "research c", structuredOutput: envelope("Compatibility"), delay: 50 });
		mockPi.onCall({ output: "verified", structuredOutput: envelope("Targeted verification") });
		const backgroundSection = "## Background\n\nDynamic workflow architecture matters because orchestration must preserve task identity, evidence lineage, and recovery state while several workers operate concurrently. The accepted architecture and compatibility evidence establishes the decision context, the boundaries of the comparison, and the operational constraints that a production implementation must respect. A useful comparison therefore covers more than feature lists: it must explain ownership, persistence, acceptance semantics, failure recovery, and how evidence moves from researchers into a coherent deliverable. These concerns determine whether parallelism improves depth or merely creates disconnected fragments that a final model compresses into another shallow summary. [Architecture evidence](https://example.test/architecture) [Compatibility evidence](https://example.test/compatibility)";
		const technicalSection = "## Technical Details\n\nThe implementation should persist the workflow graph, correlate every delegated attempt with its owner and node, and release dependent work only after explicit acceptance. Recovery must restore branch binding and durable attempt metadata, while the reviewer checks that safety claims remain traceable to fetched sources. The document pipeline also needs explicit section ownership, authoritative context bundles, and an editor that merges accepted drafts without inventing facts. Quality gates should verify outline coverage, source support, section completion, citation density, final length, and unresolved conflicts before delivery. This produces a controlled editorial pipeline instead of an unstructured summary pass and makes targeted repair possible when one section fails review. [Safety evidence](https://example.test/safety) [Verification evidence](https://example.test/targeted-verification)";
		const finalMarkdown = `# Dynamic Workflow Architecture Report\n\n${backgroundSection}\n\n${technicalSection}`;
		mockPi.onCall({ output: "background written", structuredOutput: envelope(backgroundSection, { findings: false, port: "document" }), delay: 30 });
		mockPi.onCall({ output: "technical written", structuredOutput: envelope(technicalSection, { findings: false, port: "document" }), delay: 30 });
		mockPi.onCall({ output: "edited", structuredOutput: envelope(finalMarkdown, { findings: false, port: "document" }) });
		mockPi.onCall({ output: "reviewed", structuredOutput: envelope("Review passed", { port: "review", release: true }) });

		const events = createEventBus();
		const runtimeHandlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
		const tools = new Map<string, ToolDefinition>();
		const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
			const continuationMessages: Array<{
				content: string;
				customType: string;
				display: boolean;
				triggerTurn?: boolean;
				deliverAs?: "steer" | "followUp" | "nextTurn";
			}> = [];
		const fakePi = new Proxy({
			events,
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				const handlers = runtimeHandlers.get(event) ?? [];
				handlers.push(handler);
				runtimeHandlers.set(event, handlers);
			},
			registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
				sendMessage(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) {
					if (message.customType !== "workflow-continuation-context") return;
					continuationMessages.push({
						content: message.content,
						customType: message.customType,
						display: message.display,
						...(options?.triggerTurn !== undefined ? { triggerTurn: options.triggerTurn } : {}),
						...(options?.deliverAs ? { deliverAs: options.deliverAs } : {}),
					});
				},
				sendUserMessage() {},
			appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
			getSessionName() { return undefined; },
			getAllTools() { return [...tools.keys(), "todo"].map((name) => ({ name })); },
		}, {
			get(target, property) {
				if (property in target) return target[property as keyof typeof target];
				return () => undefined;
			},
		});
		const ctx = {
			cwd,
			hasUI: false,
			mode: "tui",
			ui: { setToolsExpanded() {}, setWidget() {}, requestRender() {}, notify() {}, theme: { fg(_name: string, text: string) { return text; }, bg(_name: string, text: string) { return text; }, bold(text: string) { return text; } } },
			sessionManager: {
				getSessionId: () => "workflow-e2e-session",
				getSessionFile: () => path.join(cwd, "workflow-e2e-session.jsonl"),
				getEntries: () => entries,
				getBranch: () => entries,
			},
			modelRegistry: { getAvailable: () => [{ provider: "mock", id: "test-model", reasoning: true }] },
			isIdle: () => true,
		} as unknown as ExtensionContext;

		const callWorkflow = async (params: Record<string, unknown>): Promise<WorkflowControllerDetails> => {
			const tool = tools.get("workflow");
			assert.ok(tool, "workflow tool must be registered");
			const result = await tool.execute(`call-${Date.now()}`, params, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, undefined, result.content.find((entry) => entry.type === "text")?.text);
			assert.ok(result.details);
			return result.details as WorkflowControllerDetails;
		};

		try {
			registerSubagentExtension(fakePi as never);
			for (const handler of runtimeHandlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			const started = await callWorkflow({ action: "start", mode: "deep-research", goal: "Compare dynamic workflow architectures" });
			const runId = started.run.id;
			assert.equal(started.todoProjection?.toolAvailable, true);
			assert.ok((started.todoProjection?.operations.length ?? 0) > 0);
			await callWorkflow({
				action: "set_brief",
				runId,
				brief: {
					version: 0,
					audience: "Senior engineers",
					purpose: "Choose a durable dynamic workflow architecture",
					scope: "Architecture, safety, compatibility, and recovery",
					depth: "deep",
					deliverable: "research-report",
					targetWords: { min: 140, max: 500 },
					requiredTopics: ["Background", "Technical Details"],
					excludedTopics: [],
					constraints: ["Use accepted evidence only"],
					assumptions: [],
					clarification: "confirmed",
				},
			});
			await callWorkflow({
				action: "set_outline",
				runId,
				outline: {
					version: 0,
					title: "Dynamic Workflow Architecture Report",
					thesis: "Durable orchestration requires explicit evidence, ownership, acceptance, and recovery contracts.",
					approval: "supervisor",
					sections: [
						{ id: "background", title: "Background", objective: "Explain context and constraints", questions: ["Why does the architecture matter?"], evidenceRequirements: ["Architecture and compatibility evidence"], targetWords: 100, writerNodeId: "section-background" },
						{ id: "technical", title: "Technical Details", objective: "Explain execution and recovery mechanics", questions: ["How should orchestration work?"], evidenceRequirements: ["Safety and recovery evidence"], targetWords: 100, writerNodeId: "section-technical" },
					],
				},
			});
			const researchNodes = [
				node("research-architecture", "research", "researcher"),
				node("research-safety", "research", "researcher"),
				node("research-compatibility", "research", "researcher"),
			];
			await callWorkflow({ action: "apply_plan", runId, tasks: [{ id: "task-research", label: "Research lanes", order: 0 }], workUnits: researchNodes });
			const firstWave = await callWorkflow({ action: "run_ready", runId, concurrency: 3 });
			assert.equal(
				Object.values(firstWave.run.nodes).filter((entry) => entry.status === "completed").length,
				3,
				JSON.stringify(Object.fromEntries(Object.entries(firstWave.run.nodes).map(([id, entry]) => [id, { status: entry.status, attempts: entry.attempts }]))),
			);
			continuationMessages.length = 0;
			for (const handler of runtimeHandlers.get("agent_settled") ?? []) await handler({}, ctx);
				assert.equal(continuationMessages.length, 1);
				assert.equal(continuationMessages[0]?.customType, "workflow-continuation-context");
				assert.equal(continuationMessages[0]?.display, false);
				assert.equal(continuationMessages[0]?.triggerTurn, true);
				assert.equal(continuationMessages[0]?.deliverAs, "followUp");
			assert.match(continuationMessages[0]?.content ?? "", new RegExp(`Continue workflow ${runId}`));
				assert.match(continuationMessages[0]?.content ?? "", /Synchronize these workflow projections/);
			for (const researchNode of researchNodes) {
				await callWorkflow({ action: "accept", runId, nodeId: researchNode.id, decision: "Lane evidence accepted; named issues require verifier follow-up." });
			}

			const documentNodes = [
				node("verify-recovery-and-runtime", "verification", "research-verifier", researchNodes.map((entry) => entry.id), "task-document"),
				node("section-background", "section-writer", "research-section-writer", [...researchNodes.map((entry) => entry.id), "verify-recovery-and-runtime"], "task-document"),
				node("section-technical", "section-writer", "research-section-writer", [...researchNodes.map((entry) => entry.id), "verify-recovery-and-runtime"], "task-document"),
				node("editor", "editor", "research-editor", ["section-background", "section-technical"], "task-document"),
				node("reviewer", "reviewer", "research-reviewer", ["editor"], "task-document"),
			];
			const [verifier, sectionBackground, sectionTechnical] = documentNodes;
			await callWorkflow({ action: "apply_plan", runId, tasks: [{ id: "task-document", label: "Verification and document", order: 1 }], workUnits: documentNodes });
			const verified = await callWorkflow({ action: "run_ready", runId, concurrency: 3 });
			assert.equal(verified.run.nodes[verifier.id]?.status, "completed");
			assert.equal(verified.run.nodes[sectionBackground.id]?.status, "pending");
			await callWorkflow({ action: "accept", runId, nodeId: verifier.id, decision: "Targeted verification resolves the named gap and conflict." });
			await callWorkflow({ action: "record_decision", runId, decisionKind: "gap_resolution", target: "Does reload preserve the workflow branch binding?", rationale: "Verifier confirmed session, cwd, branch, and revision guards." });
			await callWorkflow({ action: "record_decision", runId, decisionKind: "conflict_resolution", target: "QuickJS is required for V0", rationale: "Verifier confirmed typed actions cover the V0 loop." });

			const written = await callWorkflow({ action: "run_ready", runId, concurrency: 2 });
			assert.equal(written.run.nodes[sectionBackground.id]?.status, "completed");
			assert.equal(written.run.nodes[sectionTechnical.id]?.status, "completed");
			await callWorkflow({ action: "accept", runId, nodeId: sectionBackground.id, decision: "Background section follows the approved outline and accepted evidence." });
			await callWorkflow({ action: "accept", runId, nodeId: sectionTechnical.id, decision: "Technical section follows the approved outline and accepted evidence." });
			const edited = await callWorkflow({ action: "run_ready", runId });
			assert.equal(edited.run.nodes.editor?.status, "completed");
			await callWorkflow({ action: "accept", runId, nodeId: "editor", decision: "Lead edit preserves both approved sections and registered citations." });
			const reviewed = await callWorkflow({ action: "run_ready", runId });
			assert.equal(reviewed.run.nodes.reviewer?.status, "completed");
			await callWorkflow({ action: "accept", runId, nodeId: "reviewer", decision: "Review passed citation, conflict, and coverage gates." });
			const quality = await callWorkflow({ action: "quality", runId });
			assert.equal(quality.qualityReport?.releaseReady, true, quality.qualityReport?.blockers.join("\n"));
			assert.equal(quality.qualityReport?.score, 100);
			assert.ok(fs.existsSync(quality.qualityReportPath ?? ""));
			assert.deepEqual(JSON.parse(fs.readFileSync(quality.qualityReportPath ?? "", "utf-8")), quality.qualityReport);

			const acceptedFinalMarkdown = edited.run.nodes.editor?.result?.summary.text ?? "";
			assert.equal(acceptedFinalMarkdown, finalMarkdown);
			const editorOutput = reviewed.run.nodes.editor?.outputs?.document;
			assert.ok(editorOutput && editorOutput.kind === "artifact");
			const completed = await callWorkflow({
				action: "complete",
				runId,
				nodeId: "editor",
				port: "document",
				digest: editorOutput.artifact.sha256,
			});
			assert.equal(completed.run.status, "completed");
			assert.equal(completed.evaluation?.acceptedResearchLanes, 3);
			assert.equal(completed.evaluation?.gaps, 0);
			assert.equal(completed.evaluation?.conflicts, 0);
			assert.equal(mockPi.callCount(), 8);
			assert.equal(fs.readFileSync(completed.finalPath ?? "", "utf-8"), acceptedFinalMarkdown);
			assert.ok(fs.existsSync(completed.qualityReportPath ?? ""));
		} finally {
			for (const handler of runtimeHandlers.get("session_shutdown") ?? []) await handler({}, ctx);
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
