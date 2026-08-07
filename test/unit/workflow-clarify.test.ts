import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectWorkflowClarification, WorkflowClarificationComponent, type WorkflowClarificationResult } from "../../src/tui/workflow-clarify.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

function tui() {
	return { requestRender() {} };
}

describe("workflow clarification questionnaire", () => {
	it("always offers Other and records a custom single-choice answer", () => {
		let result: WorkflowClarificationResult | undefined;
		const component = new WorkflowClarificationComponent(
			tui(),
			theme as never,
			[{ id: "audience", prompt: "目标读者？", options: [{ label: "架构师", description: "负责技术决策" }, { label: "开发者" }], multiple: false }],
			"zh",
			(value) => { result = value; },
		);

		const initial = component.render(80).join("\n");
		assert.match(initial, /─ 需求确认/);
		assert.match(initial, /1 目标读者/);
		assert.match(initial, /其他（补充说明）/);
		assert.match(initial, /负责技术决策/);
		assert.match(initial, /Enter 选择并提交/);
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		for (const character of "管理决策者") component.handleInput(character);
		component.handleInput("\r");

		assert.deepEqual(result, {
			cancelled: false,
			answers: [{ id: "audience", prompt: "目标读者？", answer: "管理决策者", selections: ["管理决策者"], wasCustom: true }],
		});
	});

	it("supports multiple selections before confirming the question", () => {
		let result: WorkflowClarificationResult | undefined;
		const component = new WorkflowClarificationComponent(
			tui(),
			theme as never,
			[{ id: "topics", prompt: "重点范围？", options: [{ label: "运行时" }, { label: "可观测性" }], multiple: true }],
			"zh",
			(value) => { result = value; },
		);

		component.handleInput(" ");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		const selected = component.render(120).join("\n");
		assert.match(selected, /\[x\] 运行时[\s\S]*\[x\] 可观测性/);
		assert.match(selected, /Space 选中\/取消或补充/);
		assert.match(selected, /Enter 提交本题/);
		component.handleInput("\r");

		assert.deepEqual(result, {
			cancelled: false,
			answers: [{ id: "topics", prompt: "重点范围？", answer: "运行时；可观测性", selections: ["运行时", "可观测性"], wasCustom: false }],
		});
	});

	it("uses Space to select and cancel multi-choice values", () => {
		let result: WorkflowClarificationResult | undefined;
		const component = new WorkflowClarificationComponent(
			tui(),
			theme as never,
			[{ id: "topics", prompt: "重点范围？", options: [{ label: "运行时" }, { label: "可观测性" }], multiple: true }],
			"zh",
			(value) => { result = value; },
		);

		component.handleInput(" ");
		assert.match(component.render(100).join("\n"), /\[x\] 运行时/);
		component.handleInput(" ");
		assert.match(component.render(100).join("\n"), /\[ \] 运行时/);
		component.handleInput("\r");
		assert.equal(result, undefined);
		assert.match(component.render(100).join("\n"), /请至少选择一项/);
	});

	it("adds Other as a real multi-choice value that can be cancelled", () => {
		let result: WorkflowClarificationResult | undefined;
		const component = new WorkflowClarificationComponent(
			tui(),
			theme as never,
			[{ id: "topics", prompt: "重点范围？", options: [{ label: "运行时" }, { label: "可观测性" }], multiple: true }],
			"zh",
			(value) => { result = value; },
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput(" ");
		for (const character of "部署成本") component.handleInput(character);
		component.handleInput("\r");
		assert.match(component.render(100).join("\n"), /\[x\] 补充：部署成本/);
		component.handleInput(" ");
		assert.match(component.render(100).join("\n"), /\[ \] 补充：部署成本/);
		component.handleInput(" ");
		component.handleInput("\r");

		assert.deepEqual(result, {
			cancelled: false,
			answers: [{ id: "topics", prompt: "重点范围？", answer: "部署成本", selections: ["部署成本"], wasCustom: true }],
		});
	});

	it("opens the questionnaire inline instead of as an overlay", async () => {
		let options: unknown = "not-called";
		const ctx = {
			ui: {
				custom(_factory: unknown, receivedOptions?: unknown) {
					options = receivedOptions;
					return Promise.resolve(undefined);
				},
			},
		};

		await collectWorkflowClarification(ctx as never, [
			{ id: "audience", prompt: "目标读者？", options: [{ label: "架构师" }, { label: "开发者" }], multiple: false },
		], "zh");
		assert.equal(options, undefined);
	});
});
