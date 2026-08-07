import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildResearchSearchPlan, formatResearchSearchPlan } from "../../src/workflows/query-strategy.ts";

describe("workflow research query strategy", () => {
	it("builds bounded coverage, authority, counterevidence, and freshness lanes", () => {
		const plan = buildResearchSearchPlan({
			goal: "Evaluate Pi subagent restart recovery",
			focus: "ready nodes resume after process exit",
			timeSensitive: true,
			preferredDomains: ["github.com", "docs.pi.dev"],
			gaps: ["Does startup actively schedule ready nodes?"],
			conflicts: [{ statement: "Resume is automatic", alternatives: ["automatic", "manual"] }],
		});

		assert.ok(plan.queries.some((query) => query.lane === "authority" && query.query.includes("site:github.com")));
		assert.ok(plan.queries.some((query) => query.lane === "counterevidence" && query.query.toLowerCase().includes("limitation")));
		assert.ok(plan.queries.some((query) => query.lane === "freshness" && query.query.includes("2026")));
		assert.ok(plan.queries.some((query) => query.reason.includes("gap")));
		assert.equal(new Set(plan.queries.map((query) => query.query.toLowerCase())).size, plan.queries.length);
		assert.ok(plan.queries.length <= plan.maxQueries);
		assert.match(formatResearchSearchPlan(plan), /Fetch and verification rules/);
	});

	it("assigns distinct source portfolios to independent first-wave lanes", () => {
		const mechanism = buildResearchSearchPlan({ goal: "Compare runtimes", focus: "workflow execution", sourcePortfolio: "mechanism" });
		const operations = buildResearchSearchPlan({ goal: "Compare runtimes", focus: "workflow execution", sourcePortfolio: "operations" });
		const alternatives = buildResearchSearchPlan({ goal: "Compare runtimes", focus: "workflow execution", sourcePortfolio: "alternatives" });

		assert.notDeepEqual(mechanism.queries.map((query) => query.query), operations.queries.map((query) => query.query));
		assert.notDeepEqual(operations.queries.map((query) => query.query), alternatives.queries.map((query) => query.query));
		assert.match(formatResearchSearchPlan(mechanism), /source portfolio: mechanism/);
	});
});
