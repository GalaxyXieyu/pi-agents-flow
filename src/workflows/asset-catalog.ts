/**
 * Read-only asset catalog for composition planning.
 *
 * The Supervisor composes a workflow by picking a base Agent per node and binding
 * skills and tools to it. To make that a single up-front decision instead of a
 * running series of guesses, it needs one view of every available building block.
 *
 * This module only aggregates the existing discovery mechanisms; it owns no
 * storage or registry of its own and never mutates workflow state. Scanning is
 * always live so an edited agent or skill takes effect immediately.
 */
import { canInvokeAgent, discoverAgents, effectiveAgentVisibility, type AgentSource } from "../agents/agents.ts";
import { discoverAvailableSkills } from "../agents/skills.ts";
import { listAvailableMcpDirectTools } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { DEEP_RESEARCH_BASE_AGENT_BY_KIND } from "./plan-rules.ts";

export interface AssetCatalogAgent {
	name: string;
	source: AgentSource;
	description: string;
	/** When true the agent also receives project skills that were not named explicitly. */
	inheritSkills: boolean;
	/** True when the agent is hidden from user-facing catalogs but still model-invocable. */
	hidden?: boolean;
	skills?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
}

export interface AssetCatalogSkill {
	name: string;
	source: string;
	description?: string;
}

export interface AssetCatalogMcpTool {
	/** Tool name as a child would call it, already carrying the configured server prefix. */
	name: string;
	server: string;
	selector: string;
}

export interface AssetCatalog {
	agents: AssetCatalogAgent[];
	skills: AssetCatalogSkill[];
	mcpTools: AssetCatalogMcpTool[];
}

export function buildAssetCatalog(cwd: string): AssetCatalog {
	const agents = discoverAgents(cwd, "both").agents
		// workflow_assets is the Supervisor's composition catalog, not a user-facing list:
		// include every model-invocable agent even when `visibility: hidden` hides it from
		// ordinary discovery. Only invocation=disabled and user-only agents are excluded.
		.filter((agent) => canInvokeAgent(agent, "model"))
		.map((agent): AssetCatalogAgent => ({
			name: agent.name,
			source: agent.source,
			description: agent.description,
			inheritSkills: agent.inheritSkills,
			...(effectiveAgentVisibility(agent) === "hidden" ? { hidden: true } : {}),
			...(agent.skills?.length ? { skills: [...agent.skills] } : {}),
			...(agent.tools?.length ? { tools: [...agent.tools] } : {}),
			...(agent.mcpDirectTools?.length ? { mcpDirectTools: [...agent.mcpDirectTools] } : {}),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const skills = discoverAvailableSkills(cwd).map((skill): AssetCatalogSkill => ({
		name: skill.name,
		source: skill.source,
		...(skill.description ? { description: skill.description } : {}),
	}));
	const mcpTools = listAvailableMcpDirectTools(cwd)
		.map((selection): AssetCatalogMcpTool => ({
			name: selection.name,
			server: selection.selector.split("/", 1)[0] ?? "",
			selector: selection.selector,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { agents, skills, mcpTools };
}

function compact(value: string | undefined, max: number): string {
	if (!value) return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function agentLine(agent: AssetCatalogAgent): string {
	const attributes = [
		`[${agent.source}]`,
		agent.hidden ? "hidden" : undefined,
		agent.inheritSkills ? "inheritSkills" : undefined,
		agent.skills ? `skills=${agent.skills.join(",")}` : undefined,
		agent.tools ? `tools=${agent.tools.join(",")}` : undefined,
		agent.mcpDirectTools ? `mcp=${agent.mcpDirectTools.join(",")}` : undefined,
	].filter((entry): entry is string => entry !== undefined);
	const description = compact(agent.description, 96);
	return `- ${agent.name} ${attributes.join(" ")}${description ? ` - ${description}` : ""}`;
}

export function formatAssetCatalog(catalog: AssetCatalog): string {
	const lines = [
		`Agents (${catalog.agents.length}) - use as agentSpec.baseAgent`,
		...catalog.agents.map(agentLine),
		"",
		"Deep Research required kind -> baseAgent mapping (roles may be hidden but remain valid agentSpec.baseAgent values)",
		...Object.entries(DEEP_RESEARCH_BASE_AGENT_BY_KIND).map(([kind, baseAgent]) => `- ${kind} -> ${baseAgent}`),
		"- research -> researcher",
		"",
		`Skills (${catalog.skills.length}) - use as agentSpec.skills`,
		...catalog.skills.map((skill) => {
			const description = compact(skill.description, 96);
			return `- ${skill.name} [${skill.source}]${description ? ` - ${description}` : ""}`;
		}),
	];
	if (catalog.skills.length === 0) lines.push("- (none)");
	lines.push(
		"",
		`MCP tools (${catalog.mcpTools.length})`,
		...catalog.mcpTools.map((tool) => `- ${tool.name} [${tool.server}]`),
	);
	if (catalog.mcpTools.length === 0) {
		lines.push("- (none discovered; MCP direct tools need a warm metadata cache)");
	}
	return lines.join("\n");
}
