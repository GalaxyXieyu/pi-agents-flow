import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	resolveWorkflowLanguage,
	workflowLanguageInstruction,
	workflowRunLanguage,
} from "../../src/workflows/language.ts";

describe("workflow language", () => {
	it("detects Chinese goals and defaults other goals to English", () => {
		assert.equal(resolveWorkflowLanguage("请分析这个插件的架构"), "zh");
		assert.equal(resolveWorkflowLanguage("Compare agent runtimes"), "en");
	});

	it("honors explicit overrides and supports legacy run fallback", () => {
		assert.equal(resolveWorkflowLanguage("中文问题", "en"), "en");
		assert.equal(resolveWorkflowLanguage("English goal", "zh"), "zh");
		assert.equal(workflowRunLanguage({ goal: "分析项目" }), "zh");
		assert.equal(workflowRunLanguage({ goal: "分析项目", language: "en" }), "en");
	});

	it("produces a strict output-language contract", () => {
		assert.match(workflowLanguageInstruction("zh"), /Simplified Chinese/);
		assert.match(workflowLanguageInstruction("en"), /use English/);
	});
});
