import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectWorkflowOutlineReview, WorkflowOutlineReviewComponent, type WorkflowOutlineReviewResult } from "../../src/tui/workflow-outline-review.ts";
import type { DocumentOutline } from "../../src/workflows/types.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const outline: DocumentOutline = {
	version: 0,
	title: "企业 Agent 框架选型",
	thesis: "应根据团队技术栈、运行时边界与平台目标进行选择。",
	approval: "user",
	sections: [
		{ id: "background", title: "背景与需求", objective: "解释企业选型背景", questions: ["为什么需要 Agent 平台？"], evidenceRequirements: ["官方架构资料"], targetWords: 700, writerNodeId: "writer-background" },
		{ id: "decision", title: "场景决策矩阵", objective: "给出可执行的选型路线", questions: ["不同团队应如何选择？"], evidenceRequirements: ["场景约束与风险分析"], targetWords: 900, writerNodeId: "writer-decision" },
	],
};

function tui() {
	return { terminal: { rows: 40, columns: 120 }, requestRender() {} };
}

describe("workflow outline review", () => {
	it("renders an inline section form with explicit submit controls", () => {
		const component = new WorkflowOutlineReviewComponent(tui(), theme as never, outline, "zh", () => {});
		const overview = component.render(100).join("\n");
		assert.match(overview, /─ 大纲确认/);
		assert.match(overview, /企业 Agent 框架选型/);
		assert.match(overview, /> 批准大纲并继续/);
		assert.match(overview, /Enter 提交/);
		assert.match(overview, /Tab\/←\/→ 查看章节/);

		component.handleInput("\x1b[C");
		const section = component.render(100).join("\n");
		assert.match(section, /背景与需求/);
		assert.match(section, /为什么需要 Agent 平台/);
		assert.match(section, /writer-background/);
	});

	it("approves with Enter on the default action", () => {
		let result: WorkflowOutlineReviewResult | undefined;
		const component = new WorkflowOutlineReviewComponent(tui(), theme as never, outline, "zh", (value) => { result = value; });
		component.handleInput("\r");
		assert.deepEqual(result, { cancelled: false, approved: true });
	});

	it("collects revision feedback before rejecting the draft", () => {
		let result: WorkflowOutlineReviewResult | undefined;
		const component = new WorkflowOutlineReviewComponent(tui(), theme as never, outline, "zh", (value) => { result = value; });
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		assert.match(component.render(100).join("\n"), /修改意见/);
		for (const character of "提高 PoC 路线权重") component.handleInput(character);
		component.handleInput("\r");
		assert.deepEqual(result, { cancelled: false, approved: false, feedback: "提高 PoC 路线权重" });
	});

	it("opens inline rather than as an overlay", async () => {
		let options: unknown = "not-called";
		const ctx = { ui: { custom(_factory: unknown, receivedOptions?: unknown) { options = receivedOptions; return Promise.resolve(undefined); } } };
		await collectWorkflowOutlineReview(ctx as never, outline, "zh");
		assert.equal(options, undefined);
	});
});
