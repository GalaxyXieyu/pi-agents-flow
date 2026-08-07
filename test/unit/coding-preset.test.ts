import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertWorkflowDataFlow } from "../../src/workflows/data-contract.ts";
import {
	buildCodingWorkflowPlan,
	CODING_APPROVAL_ANNOTATION,
	type CodingStage,
} from "../../src/workflows/coding-preset.ts";

function ids(stage: CodingStage): string[] {
	return buildCodingWorkflowPlan(stage).workUnits.map((unit) => unit.id);
}

describe("coding workflow presets", () => {
	it("builds deterministic plan, build, verify, and full DAGs", () => {
		assert.deepEqual(ids("plan"), ["coding-assumptions", "coding-plan", "coding-plan-check"]);
		assert.deepEqual(ids("build"), ["coding-build", "coding-review", "coding-build-verify"]);
		assert.deepEqual(ids("verify"), ["coding-review", "coding-integration", "coding-verify"]);
		assert.deepEqual(ids("full"), [
			"coding-assumptions",
			"coding-plan",
			"coding-plan-check",
			"coding-build",
			"coding-review",
			"coding-integration",
			"coding-verify",
		]);
	});

	it("uses the intended hidden implementation agents", () => {
		const plan = buildCodingWorkflowPlan("full");
		assert.deepEqual(plan.workUnits.map((unit) => unit.agentSpec.baseAgent), [
			"assumptions-analyzer",
			"planner",
			"plan-checker",
			"executor",
			"reviewer",
			"integration-checker",
			"verifier",
		]);
	});

	it("builds well-shaped work units with approval gate on the plan check", () => {
		for (const stage of ["plan", "build", "verify", "full"] as const) {
			const plan = buildCodingWorkflowPlan(stage);
			assert.ok(plan.workUnits.length > 0, `${stage} should have work units`);
			for (const unit of plan.workUnits) {
				assert.equal(unit.dataContract.version, 1, `${unit.id} must declare V1 contract`);
				assert.ok(unit.dataContract.outputs.result, `${unit.id} must declare result port`);
			}
		}
		const full = buildCodingWorkflowPlan("full");
		const planCheck = full.workUnits.find((unit) => unit.id === "coding-plan-check");
		assert.deepEqual(planCheck?.dataContract.annotations?.[CODING_APPROVAL_ANNOTATION], {
			required: true,
			gate: "implementation",
		});
	});

	it("keeps full implementation locked behind the accepted plan check", () => {
		const plan = buildCodingWorkflowPlan("full");
		const check = plan.workUnits.find((unit) => unit.id === "coding-plan-check");
		const build = plan.workUnits.find((unit) => unit.id === "coding-build");
		assert.deepEqual(check?.dataContract.annotations?.[CODING_APPROVAL_ANNOTATION], {
			required: true,
			gate: "implementation",
		});
		assert.deepEqual(build?.dependsOn, ["coding-plan", "coding-plan-check"]);
		const review = plan.workUnits.find((unit) => unit.id === "coding-review");
		const integration = plan.workUnits.find((unit) => unit.id === "coding-integration");
		const verifier = plan.workUnits.find((unit) => unit.id === "coding-verify");
		assert.deepEqual(review?.dependsOn, ["coding-build"]);
		assert.deepEqual(integration?.dependsOn, ["coding-build"]);
		assert.deepEqual(verifier?.dependsOn, ["coding-build", "coding-review", "coding-integration"]);
		for (const planningNode of plan.workUnits.slice(0, 3)) {
			assert.deepEqual(planningNode.agentSpec.denyTools, ["bash", "edit", "write"]);
			assert.equal(planningNode.agentSpec.extraTools, undefined);
		}
	});

	it("declares valid direct-dependency V1 data contracts for every stage", () => {
		for (const stage of ["plan", "build", "verify", "full"] as const) {
			const plan = buildCodingWorkflowPlan(stage);
			assert.doesNotThrow(() => assertWorkflowDataFlow(plan.workUnits), stage);
			for (const unit of plan.workUnits) {
				assert.equal(unit.dataContract.version, 1);
				assert.equal(
					unit.dataContract.profile,
					unit.kind === "verification" ? "research" : unit.kind === "reviewer" ? "reviewer" : "generic",
				);
				assert.ok(unit.dataContract.outputs.result);
			}
		}
	});
});
