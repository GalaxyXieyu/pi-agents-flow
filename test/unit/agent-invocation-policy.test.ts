import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { handleManagementAction } from "../../src/agents/agent-management.ts";
import {
	canInvokeAgent,
	discoverAgents,
	effectiveAgentInvocation,
	effectiveAgentVisibility,
	isAgentVisibleToModel,
	type AgentConfig,
} from "../../src/agents/agents.ts";
import { validateAgentInvocationPolicy } from "../../src/runs/foreground/subagent-executor.ts";
import { buildAssetCatalog } from "../../src/workflows/asset-catalog.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
const tempDirs: string[] = [];

function createProject(): string {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-agent-policy-"));
	tempDirs.push(project);
	return project;
}

function writeAgent(project: string, name: string, extra = ""): void {
	const filePath = path.join(project, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} policy agent\n${extra}---\n\nRun ${name}.\n`, "utf-8");
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent invocation policy", () => {
	it("keeps omitted policy backward compatible", () => {
		const agent: AgentConfig = {
			name: "worker",
			description: "Worker",
			systemPrompt: "Work",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			source: "project",
			filePath: "/tmp/worker.md",
		};

		assert.equal(effectiveAgentVisibility(agent), "default");
		assert.equal(effectiveAgentInvocation(agent), "both");
		assert.equal(isAgentVisibleToModel(agent), true);
		assert.equal(canInvokeAgent(agent, "model"), true);
		assert.equal(canInvokeAgent(agent, "user"), true);
	});

	it("parses the complete invocation matrix and validates origins", () => {
		const project = createProject();
		writeAgent(project, "both-agent", "invocation: both\n");
		writeAgent(project, "model-agent", "invocation: model\n");
		writeAgent(project, "user-agent", "invocation: user\nvisibility: hidden\n");
		writeAgent(project, "disabled-agent", "invocation: disabled\n");
		const agents = discoverAgents(project, "project").agents;

		assert.equal(validateAgentInvocationPolicy({ agent: "both-agent" }, agents, "model"), undefined);
		assert.equal(validateAgentInvocationPolicy({ agent: "both-agent" }, agents, "user"), undefined);
		assert.equal(validateAgentInvocationPolicy({ agent: "model-agent" }, agents, "user"), "Agent 'model-agent' does not allow user invocation (configured invocation: model).");
		assert.equal(validateAgentInvocationPolicy({ agent: "user-agent" }, agents, "model"), "Agent 'user-agent' does not allow model invocation (configured invocation: user).");
		assert.equal(validateAgentInvocationPolicy({ agent: "disabled-agent" }, agents, "user"), "Agent 'disabled-agent' does not allow user invocation (configured invocation: disabled).");
		assert.equal(validateAgentInvocationPolicy({ tasks: [
			{ agent: "both-agent", task: "ok" },
			{ agent: "user-agent", task: "blocked" },
		] }, agents, "model"), "Agent 'user-agent' does not allow model invocation (configured invocation: user).");
		assert.equal(validateAgentInvocationPolicy({ chain: [
			{ agent: "both-agent", task: "ok" },
			{ parallel: [{ agent: "disabled-agent", task: "blocked" }] },
		] }, agents, "model"), "Agent 'disabled-agent' does not allow model invocation (configured invocation: disabled).");
	});

	it("hides hidden agents from model catalogs while preserving management discovery", () => {
		const project = createProject();
		writeAgent(project, "hidden-user", "visibility: hidden\ninvocation: user\n");
		writeAgent(project, "visible-user", "invocation: user\n");
		writeAgent(project, "visible-model", "invocation: model\n");
		const ctx = { cwd: project, modelRegistry: { getAvailable: () => [] } };

		const listText = readText(handleManagementAction("list", { agentScope: "project" }, ctx));
		assert.doesNotMatch(listText, /hidden-user/);
		assert.match(listText, /visible-model/);
		assert.match(listText, /Restricted agents \(not executable in this session/);
		assert.match(listText, /visible-user/);

		const getText = readText(handleManagementAction("get", { agent: "hidden-user", agentScope: "project" }, ctx));
		assert.match(getText, /Visibility: hidden/);
		assert.match(getText, /Invocation: user/);

		const catalogNames = buildAssetCatalog(project).agents.map((agent) => agent.name);
		assert.ok(catalogNames.includes("visible-model"));
		assert.ok(!catalogNames.includes("hidden-user"));
		assert.ok(!catalogNames.includes("visible-user"));
	});

	it("keeps user-profile Coding workers hidden and model-only", () => {
		const discovered = discoverAgents(repoRoot, "both").agents;
		const visible = discovered
			.filter((agent) => isAgentVisibleToModel(agent) && canInvokeAgent(agent, "model"))
			.map((agent) => agent.name)
			.sort();
		assert.deepEqual(visible, ["debugger", "oracle", "researcher", "scout"]);

		for (const name of ["worker", "reviewer", "planner", "verifier", "assumptions-analyzer", "plan-checker", "executor", "integration-checker"]) {
			const agent = discovered.find((candidate) => candidate.name === name);
			assert.ok(agent, `expected '${name}' to be discovered for trusted Workflow execution`);
			assert.equal(agent.visibility, "hidden", name);
			assert.equal(agent.invocation, "model", name);
			assert.equal(canInvokeAgent(agent, "model"), true, name);
			assert.equal(canInvokeAgent(agent, "user"), false, name);
		}
	});

	it("rejects invalid policy frontmatter", () => {
		const project = createProject();
		writeAgent(project, "bad-visibility", "visibility: private\n");
		assert.throws(() => discoverAgents(project, "project"), /invalid visibility frontmatter/);
		fs.rmSync(path.join(project, ".pi", "agents", "bad-visibility.md"));
		writeAgent(project, "bad-invocation", "invocation: automatic\n");
		assert.throws(() => discoverAgents(project, "project"), /invalid invocation frontmatter/);
	});
});
