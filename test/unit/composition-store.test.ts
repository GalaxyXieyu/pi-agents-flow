import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	compositionPath,
	formatCompositionSummary,
	listCompositions,
	loadComposition,
	parseCompositionParamArgs,
	parseCompositionTemplate,
	renderComposition,
	resolveCompositionParams,
	saveComposition,
	type CompositionTemplate,
} from "../../src/workflows/composition-store.ts";

function agentSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "spec",
		baseAgent: "worker",
		role: "Engineer",
		objective: "Do the work",
		instructions: "Follow the plan",
		context: "fresh",
		...overrides,
	};
}

function template(overrides: Partial<CompositionTemplate> = {}): CompositionTemplate {
	return parseCompositionTemplate({
		name: "plan-dev-verify",
		description: "Plan then build then verify",
		params: [
			{ name: "goal", required: true },
			{ name: "targetModule", required: true },
		],
		tasks: [
			{ id: "task-plan", label: "Planning", order: 0 },
			{ id: "task-build", label: "Build and verify", order: 1 },
		],
		workUnits: [
			{ id: "plan", taskId: "task-plan", kind: "custom", label: "Plan {{targetModule}}", order: 0, dependsOn: [], agentSpec: agentSpec({ baseAgent: "planner", objective: "Plan {{targetModule}}: {{goal}}" }) },
			{ id: "dev", taskId: "task-build", kind: "custom", label: "Build", order: 0, dependsOn: ["plan"], agentSpec: agentSpec() },
			{ id: "db-verify", taskId: "task-build", kind: "verification", label: "Verify db", order: 1, dependsOn: ["dev"], enableIf: 'targetModule.includes("db")', agentSpec: agentSpec({ baseAgent: "reviewer" }) },
			{ id: "verify", taskId: "task-build", kind: "verification", label: "Verify", order: 2, dependsOn: ["dev"], agentSpec: agentSpec({ baseAgent: "reviewer" }) },
		],
		...overrides,
	});
}

describe("composition store", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-flow-composition-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	describe("persistence", () => {
		it("saves, lists, and loads a template round-trip", () => {
			const saved = saveComposition(cwd, template());
			assert.equal(saved, compositionPath(cwd, "plan-dev-verify"));
			assert.deepEqual(listCompositions(cwd), ["plan-dev-verify"]);
			const loaded = loadComposition(cwd, "plan-dev-verify");
			assert.equal(loaded.name, "plan-dev-verify");
			assert.equal(loaded.tasks.length, 2);
			assert.equal(loaded.workUnits.length, 4);
			assert.equal(loaded.workUnits[2]?.enableIf, 'targetModule.includes("db")');
		});

		it("overwrites same-name templates without keeping history", () => {
			saveComposition(cwd, template());
			saveComposition(cwd, template({ description: "second revision" }));
			assert.deepEqual(listCompositions(cwd), ["plan-dev-verify"]);
			assert.equal(loadComposition(cwd, "plan-dev-verify").description, "second revision");
			assert.deepEqual(fs.readdirSync(path.join(cwd, ".pi/agents-flow", "compositions")), ["plan-dev-verify.json"]);
		});

		it("returns an empty list when nothing is saved", () => {
			assert.deepEqual(listCompositions(cwd), []);
		});

		it("rejects unsafe names and missing files", () => {
			assert.throws(() => compositionPath(cwd, "../escape"), /only letters, numbers/);
			assert.throws(() => loadComposition(cwd, "absent"), /not found/);
		});

		it("rejects invalid json and structurally invalid templates", () => {
			const filePath = compositionPath(cwd, "broken");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "{not json");
			assert.throws(() => loadComposition(cwd, "broken"), /not valid JSON/);
			assert.throws(() => parseCompositionTemplate({ name: "x", tasks: [{ id: "t", label: "T", order: 0 }], workUnits: [] }), /non-empty array/);
			assert.throws(() => parseCompositionTemplate({ name: "x", tasks: [{ id: "t", label: "T", order: 0 }], workUnits: [{ id: "a", taskId: "t", kind: "nope", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() }] }), /kind is invalid/);
			assert.throws(() => parseCompositionTemplate({
				name: "x",
				tasks: [{ id: "t", label: "T", order: 0 }],
				workUnits: [
					{ id: "a", taskId: "t", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() },
					{ id: "a", taskId: "t", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() },
				],
			}), /Duplicate composition work unit/);
			assert.throws(() => parseCompositionTemplate({
				name: "x",
				tasks: [{ id: "t", label: "T", order: 0, parentId: "missing" }],
				workUnits: [{ id: "a", taskId: "t", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() }],
			}), /unknown parent/);
			assert.throws(() => parseCompositionTemplate({
				name: "x",
				tasks: [{ id: "t", label: "T", order: 0 }],
				workUnits: [{ id: "a", taskId: "missing", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() }],
			}), /unknown task/);
			assert.throws(() => parseCompositionTemplate({
				name: "x",
				params: [{ name: "p" }, { name: "p" }],
				tasks: [{ id: "t", label: "T", order: 0 }],
				workUnits: [{ id: "a", taskId: "t", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() }],
			}), /Duplicate composition param/);
		});
	});

	describe("params", () => {
		it("parses typed --param pairs", () => {
			assert.deepEqual(
				parseCompositionParamArgs(["goal=ship it", "count=3", "hasDb=true", "note="]),
				{ goal: "ship it", count: 3, hasDb: true, note: "" },
			);
			assert.throws(() => parseCompositionParamArgs(["novalue"]), /expected name=value/);
			assert.throws(() => parseCompositionParamArgs(["=x"]), /expected name=value/);
		});

		it("applies defaults and rejects missing or undeclared params", () => {
			const withDefault = parseCompositionTemplate({
				name: "t",
				params: [{ name: "a", required: true }, { name: "b", required: false, default: "fallback" }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [{ id: "n", taskId: "task", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() }],
			});
			assert.deepEqual(resolveCompositionParams(withDefault, { a: "x" }), { a: "x", b: "fallback" });
			assert.throws(() => resolveCompositionParams(withDefault, {}), /missing required param: a/);
			assert.throws(() => resolveCompositionParams(withDefault, { a: "x", c: "y" }), /does not declare param 'c'/);
		});
	});

	describe("rendering", () => {
		it("substitutes placeholders and adds a default WorkflowDataContract V1", () => {
			const rendered = renderComposition(template(), { goal: "ship it", targetModule: "payments" });
			assert.equal(rendered.workUnits[0]?.label, "Plan payments");
			assert.equal(rendered.workUnits[0]?.agentSpec.objective, "Plan payments: ship it");
			assert.deepEqual(rendered.workUnits[0]?.dataContract, {
				version: 1,
				profile: "generic",
				inputs: [],
				outputs: {
					result: {
						mediaType: "text/markdown",
						description: "Composition work-unit output",
						storage: "artifact",
						required: true,
						classification: "internal",
					},
				},
			});
		});

		it("binds default contracts to accepted direct dependency outputs", () => {
			const rendered = renderComposition(template(), { goal: "ship it", targetModule: "payments" });
			assert.deepEqual(rendered.workUnits.find((unit) => unit.id === "dev")?.dataContract.inputs, [{
				name: "dependencies",
				from: [{ nodeId: "plan", port: "result" }],
				purpose: "Accepted direct dependency outputs",
				delivery: "manifest",
				merge: "first",
				required: true,
			}]);
		});

		it("prunes explicit contract inputs that reference a conditional node", () => {
			const explicit = parseCompositionTemplate({
				name: "t",
				params: [{ name: "enabled", required: true }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [
					{ id: "base", taskId: "task", kind: "custom", label: "Base", order: 0, dependsOn: [], agentSpec: agentSpec() },
					{ id: "optional", taskId: "task", kind: "custom", label: "Optional", order: 1, dependsOn: ["base"], enableIf: "enabled", agentSpec: agentSpec() },
					{
						id: "tail",
						taskId: "task",
						kind: "custom",
						label: "Tail",
						order: 2,
						dependsOn: ["base", "optional"],
						agentSpec: agentSpec(),
						dataContract: {
							version: 1,
							profile: "generic",
							inputs: [{ name: "deps", purpose: "Deps", from: [{ nodeId: "base", port: "result" }, { nodeId: "optional", port: "result" }], merge: "list" }],
							outputs: { result: { mediaType: "text/plain", description: "Result", storage: "artifact", required: true, classification: "internal" } },
						},
					},
				],
			});
			const rendered = renderComposition(explicit, { enabled: false });
			const inputs = rendered.workUnits.find((unit) => unit.id === "tail")?.dataContract.inputs as Array<Record<string, unknown>>;
			assert.deepEqual(inputs[0]?.from, [{ nodeId: "base", port: "result" }]);
			assert.equal(inputs[0]?.merge, "first");
		});

		it("keeps conditional work units when enableIf is true", () => {
			const rendered = renderComposition(template(), { goal: "g", targetModule: "db-core" });
			assert.deepEqual(rendered.workUnits.map((unit) => unit.id), ["plan", "dev", "db-verify", "verify"]);
			assert.deepEqual(rendered.skipped, []);
		});

		it("prunes conditional work units when enableIf is false", () => {
			const rendered = renderComposition(template(), { goal: "g", targetModule: "payments" });
			assert.deepEqual(rendered.workUnits.map((unit) => unit.id), ["plan", "dev", "verify"]);
			assert.deepEqual(rendered.skipped, [{ id: "db-verify", enableIf: 'targetModule.includes("db")' }]);
		});

		it("supports a plain boolean param as a switch", () => {
			const switched = parseCompositionTemplate({
				name: "t",
				params: [{ name: "hasDb", required: true }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [
					{ id: "base", taskId: "task", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() },
					{ id: "extra", taskId: "task", kind: "custom", label: "l", order: 1, dependsOn: ["base"], enableIf: "hasDb", agentSpec: agentSpec() },
				],
			});
			assert.deepEqual(renderComposition(switched, { hasDb: true }).workUnits.map((unit) => unit.id), ["base", "extra"]);
			assert.deepEqual(renderComposition(switched, { hasDb: false }).workUnits.map((unit) => unit.id), ["base"]);
		});

		it("drops dependencies on pruned work units so the graph cannot deadlock", () => {
			const chained = parseCompositionTemplate({
				name: "t",
				params: [{ name: "hasDb", required: true }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [
					{ id: "base", taskId: "task", kind: "custom", label: "l", order: 0, dependsOn: [], agentSpec: agentSpec() },
					{ id: "optional", taskId: "task", kind: "custom", label: "l", order: 1, dependsOn: ["base"], enableIf: "hasDb", agentSpec: agentSpec() },
					{ id: "tail", taskId: "task", kind: "custom", label: "l", order: 2, dependsOn: ["base", "optional"], agentSpec: agentSpec() },
				],
			});
			const rendered = renderComposition(chained, { hasDb: false });
			assert.deepEqual(rendered.workUnits.map((unit) => unit.id), ["base", "tail"]);
			assert.deepEqual(rendered.workUnits.find((unit) => unit.id === "tail")?.dependsOn, ["base"]);
		});

		it("fails loudly on a bad enableIf instead of silently skipping the work unit", () => {
			const broken = parseCompositionTemplate({
				name: "t",
				params: [{ name: "a", required: true }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [{ id: "n", taskId: "task", kind: "custom", label: "l", order: 0, dependsOn: [], enableIf: "typoParam", agentSpec: agentSpec() }],
			});
			assert.throws(() => renderComposition(broken, { a: "x" }), /enableIf failed/);
		});

		it("fails on placeholders that reference undeclared params", () => {
			const broken = parseCompositionTemplate({
				name: "t",
				params: [{ name: "a", required: true }],
				tasks: [{ id: "task", label: "T", order: 0 }],
				workUnits: [{ id: "n", taskId: "task", kind: "custom", label: "{{missing}}", order: 0, dependsOn: [], agentSpec: agentSpec() }],
			});
			assert.throws(() => renderComposition(broken, { a: "x" }), /undeclared param 'missing'/);
		});

		it("never leaves enableIf on the rendered plan", () => {
			const rendered = renderComposition(template(), { goal: "g", targetModule: "db" });
			for (const unit of rendered.workUnits) {
				assert.equal(Object.hasOwn(unit, "enableIf"), false);
			}
		});
	});

	it("formats a readable summary", () => {
		const text = formatCompositionSummary(template());
		assert.match(text, /^plan-dev-verify - Plan then build then verify$/m);
		assert.match(text, /^Params \(2\)$/m);
		assert.match(text, /^- goal \[required\]$/m);
		assert.match(text, /^Tasks \(2\)$/m);
		assert.match(text, /^Work units \(4\)$/m);
		assert.match(text, /^- db-verify \(verification\) in task-build after dev if targetModule\.includes\("db"\)$/m);
	});
});
