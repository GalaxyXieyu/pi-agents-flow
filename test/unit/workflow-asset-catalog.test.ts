import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildAssetCatalog, formatAssetCatalog } from "../../src/workflows/asset-catalog.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("workflow asset catalog", () => {
	it("aggregates agents, skills, and mcp tools from live discovery", () => {
		const catalog = buildAssetCatalog(projectRoot);

		assert.ok(catalog.agents.length > 0, "expected discovered agents");
		assert.ok(catalog.skills.length > 0, "expected discovered skills");
		assert.ok(Array.isArray(catalog.mcpTools));

		const scout = catalog.agents.find((agent) => agent.name === "scout");
		assert.ok(scout, "expected the directly selectable scout in the catalog");
		assert.equal(typeof scout.description, "string");
		assert.equal(typeof scout.inheritSkills, "boolean");
		assert.ok(scout.tools?.includes("read"));
		for (const hidden of ["worker", "reviewer", "planner", "verifier", "research-reviewer"]) {
			assert.equal(catalog.agents.some((agent) => agent.name === hidden), false, `hidden Workflow role '${hidden}' must not leak into dynamic discovery`);
		}

		assert.ok(catalog.skills.some((skill) => skill.name === "deep-research"));
	});

	it("sorts agents and mcp tools by name and never repeats an agent", () => {
		const catalog = buildAssetCatalog(projectRoot);

		const agentNames = catalog.agents.map((agent) => agent.name);
		assert.deepEqual(agentNames, [...agentNames].sort((a, b) => a.localeCompare(b)));
		assert.equal(new Set(agentNames).size, agentNames.length);

		const mcpNames = catalog.mcpTools.map((tool) => tool.name);
		assert.deepEqual(mcpNames, [...mcpNames].sort((a, b) => a.localeCompare(b)));
	});

	it("omits empty optional fields instead of emitting empty arrays", () => {
		const catalog = buildAssetCatalog(projectRoot);
		for (const agent of catalog.agents) {
			assert.notEqual(agent.skills?.length, 0);
			assert.notEqual(agent.tools?.length, 0);
			assert.notEqual(agent.mcpDirectTools?.length, 0);
		}
	});

	it("formats a catalog with a section per asset kind", () => {
		const text = formatAssetCatalog(buildAssetCatalog(projectRoot));
		assert.match(text, /^Agents \(\d+\) - use as agentSpec\.baseAgent$/m);
		assert.match(text, /^Skills \(\d+\) - use as agentSpec\.skills$/m);
		assert.match(text, /^MCP tools \(\d+\)$/m);
		assert.match(text, /^- scout \[/m);
		assert.match(text, /^Deep Research required kind -> baseAgent mapping/m);
		assert.match(text, /^- outline -> research-architect$/m);
		assert.match(text, /^- section-writer -> research-section-writer$/m);
		assert.doesNotMatch(text, /^- (worker|reviewer|planner|verifier|research-reviewer) \[/m);
	});

	it("keeps placeholder lines for empty sections", () => {
		const text = formatAssetCatalog({ agents: [], skills: [], mcpTools: [] });
		assert.match(text, /^Agents \(0\)/m);
		assert.match(text, /^- \(none\)$/m);
		assert.match(text, /^- \(none discovered; MCP direct tools need a warm metadata cache\)$/m);
	});
});
