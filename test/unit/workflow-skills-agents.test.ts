import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { discoverAgents } from "../../src/agents/agents.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("workflow skills and agents", () => {
	it("discovers the research editorial team with bounded tool sets", () => {
		const agents = discoverAgents(projectRoot, "both").agents;
		const architect = agents.find((agent) => agent.name === "research-architect");
		const verifier = agents.find((agent) => agent.name === "research-verifier");
		const writer = agents.find((agent) => agent.name === "research-writer");
		const sectionWriter = agents.find((agent) => agent.name === "research-section-writer");
		const editor = agents.find((agent) => agent.name === "research-editor");
		const reviewer = agents.find((agent) => agent.name === "research-reviewer");
		assert.deepEqual(architect?.tools, ["read", "intercom"]);
		assert.ok(verifier?.tools?.includes("web_search"));
		assert.deepEqual(writer?.tools, ["read", "write"]);
		assert.deepEqual(sectionWriter?.tools, ["read", "write"]);
		assert.deepEqual(editor?.tools, ["read", "write"]);
		assert.ok(reviewer?.tools?.includes("fetch_content"));
		assert.equal(reviewer?.tools?.includes("web_search"), false);
	});

	it("preflights package-local deep-research skill injection for local extension development", async () => {
		const result = await resolveSubagentLaunchContract({
			agent: "research-writer",
			cwd: projectRoot,
			task: "Write accepted findings",
			skill: ["deep-research"],
			outputSchema: { type: "object" },
			runId: "workflow-writer-preflight",
		});
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.contract.skills.requested, ["deep-research"]);
			assert.equal(result.contract.skills.resolved[0]?.name, "deep-research");
			assert.match(result.contract.skills.resolved[0]?.path ?? "", /skills\/deep-research\/SKILL\.md$/);
			assert.equal(result.contract.tools.effectiveAllowlist.includes("web_search"), false);
		}
	});
});
