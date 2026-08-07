import { normalizeWorkflowText } from "./text-normalize.ts";

export type ResearchQueryLane = "coverage" | "authority" | "counterevidence" | "freshness" | "gap" | "conflict";
export type ResearchSourcePortfolio = "mechanism" | "implementation" | "operations" | "alternatives";

export interface ResearchSearchQuery {
	lane: ResearchQueryLane;
	query: string;
	reason: string;
}

export interface ResearchSearchPlan {
	version: 0;
	goal: string;
	focus: string;
	maxQueries: number;
	maxFetches: number;
	sourcePortfolio: ResearchSourcePortfolio;
	queries: ResearchSearchQuery[];
}

interface BuildResearchSearchPlanInput {
	goal: string;
	focus?: string;
	timeSensitive?: boolean;
	preferredDomains?: string[];
	sourcePortfolio?: ResearchSourcePortfolio;
	gaps?: string[];
	conflicts?: Array<{ statement: string; alternatives?: string[] }>;
	maxQueries?: number;
	maxFetches?: number;
	currentYear?: number;
}

export function buildResearchSearchPlan(input: BuildResearchSearchPlanInput): ResearchSearchPlan {
	const goal = input.goal.trim();
	const focus = input.focus?.trim() || goal;
	const maxQueries = input.maxQueries ?? 12;
	const maxFetches = input.maxFetches ?? 8;
	const sourcePortfolio = input.sourcePortfolio ?? "mechanism";
	const domains = [...new Set((input.preferredDomains ?? []).map((domain) => domain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")).filter(Boolean))];
	const domainFilter = domains.length > 0 ? domains.map((domain) => `site:${domain}`).join(" OR ") : "official documentation OR GitHub source";
	const portfolioQueries: Record<ResearchSourcePortfolio, ResearchSearchQuery[]> = {
		mechanism: [
			{ lane: "coverage", query: `${focus} architecture mechanism`, reason: "Establish the direct mechanism and coverage baseline." },
			{ lane: "authority", query: `${focus} ${domainFilter}`, reason: "Locate first-party documentation, source, specifications, or release notes." },
			{ lane: "counterevidence", query: `${focus} limitation failure caveat`, reason: "Actively search for failure modes that could falsify the leading mechanism." },
		],
		implementation: [
			{ lane: "coverage", query: `${focus} source code implementation`, reason: "Trace the behavior to a reproducible implementation rather than a restated claim." },
			{ lane: "authority", query: `${focus} repository specification ${domainFilter}`, reason: "Prefer source repositories, API contracts, and executable specifications." },
			{ lane: "counterevidence", query: `${focus} issue regression bug`, reason: "Look for implementation-level regressions and known failure cases." },
		],
		operations: [
			{ lane: "coverage", query: `${focus} deployment operations recovery`, reason: "Cover lifecycle, recovery, and operational behavior that architecture pages often omit." },
			{ lane: "authority", query: `${focus} release notes changelog ${domainFilter}`, reason: "Use dated releases and operational notes to validate current behavior." },
			{ lane: "counterevidence", query: `${focus} outage failure limitation postmortem`, reason: "Test whether the promised behavior survives real operational constraints." },
		],
		alternatives: [
			{ lane: "coverage", query: `${focus} alternatives comparison benchmark`, reason: "Map credible alternatives and the dimensions on which they differ." },
			{ lane: "authority", query: `${focus} technical report benchmark tradeoff`, reason: "Prefer transparent comparative evidence over generic listicles." },
			{ lane: "counterevidence", query: `${focus} tradeoff limitation migration cost`, reason: "Find evidence that could invalidate a one-sided recommendation." },
		],
	};
	const candidates: ResearchSearchQuery[] = [...portfolioQueries[sourcePortfolio]];
	if (input.timeSensitive) {
		candidates.push({
			lane: "freshness",
			query: `${focus} ${input.currentYear ?? new Date().getUTCFullYear()} release changelog`,
			reason: "Validate current behavior and version-sensitive claims.",
		});
	}
	for (const gap of input.gaps ?? []) {
		candidates.push({ lane: "gap", query: `${gap.trim()} primary source`, reason: `Close release-critical gap: ${gap.trim()}` });
	}
	for (const conflict of input.conflicts ?? []) {
		const alternatives = conflict.alternatives?.map((value) => value.trim()).filter(Boolean).join(" vs ");
		candidates.push({
			lane: "conflict",
			query: `${conflict.statement.trim()}${alternatives ? ` ${alternatives}` : ""} evidence`,
			reason: `Resolve conflicting claim: ${conflict.statement.trim()}`,
		});
	}
	const seen = new Set<string>();
	const queries = candidates.filter((candidate) => {
		const key = normalizeWorkflowText(candidate.query);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, maxQueries);
	return { version: 0, goal, focus, maxQueries, maxFetches, sourcePortfolio, queries };
}

export function formatResearchSearchPlan(plan: ResearchSearchPlan): string {
	return [
		"## Runtime research query plan",
		`- source portfolio: ${plan.sourcePortfolio}`,
		...plan.queries.map((query) => `- [${query.lane}] ${query.query} — ${query.reason}`),
		"",
		"## Fetch and verification rules",
		`- Fetch at most ${plan.maxFetches} high-value sources before evaluating gaps; search snippets do not count as evidence.`,
		"- Rank official docs, source repositories, specs, release notes, and direct reports above commentary.",
		"- Record every issued query, fetched URL, and dropped source in the ResultEnvelope search trace.",
		"- Stop broad search after coverage; use only narrow gap/conflict queries for the repair pass.",
	].join("\n");
}
