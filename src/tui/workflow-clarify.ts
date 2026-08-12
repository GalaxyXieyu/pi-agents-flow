import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import type { WorkflowClarificationAnswer, WorkflowClarificationQuestion } from "../workflows/types.ts";
import type { WorkflowClarificationResult } from "../workflows/interaction.ts";

export type { WorkflowClarificationResult } from "../workflows/interaction.ts";

type Theme = ExtensionContext["ui"]["theme"];

interface ClarificationTui {
	requestRender(): void;
}

interface DisplayOption {
	value: string;
	label: string;
	description?: string;
	isOther?: boolean;
	isCustom?: boolean;
}

function addWrapped(lines: string[], prefix: string, text: string, width: number): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		lines.push(...wrapTextWithAnsi(`${prefix}${text}`, width));
		return;
	}
	const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
	for (const [index, line] of wrapped.entries()) lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

export class WorkflowClarificationComponent implements Component {
	private readonly tui: ClarificationTui;
	private readonly theme: Theme;
	private readonly questions: WorkflowClarificationQuestion[];
	private readonly language: "zh" | "en";
	private readonly done: (result: WorkflowClarificationResult) => void;
	private readonly editor: Editor;
	private readonly answers = new Map<string, WorkflowClarificationAnswer>();
	private readonly selections = new Map<string, Set<string>>();
	private readonly customSelections = new Map<string, Set<string>>();
	private questionIndex = 0;
	private optionIndex = 0;
	private editingOther = false;
	private notice: string | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		tui: ClarificationTui,
		theme: Theme,
		questions: WorkflowClarificationQuestion[],
		language: "zh" | "en",
		done: (result: WorkflowClarificationResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.questions = questions;
		this.language = language;
		this.done = done;
		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui as never, editorTheme);
		this.editor.onSubmit = (value) => this.submitOther(value);
	}

	private refresh(): void {
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private question(): WorkflowClarificationQuestion {
		return this.questions[this.questionIndex]!;
	}

	private options(): DisplayOption[] {
		const otherDescription = this.question().multiple
			? (this.language === "zh" ? "按 Space 输入选项之外的背景或要求" : "Press Space to add context not covered above")
			: (this.language === "zh" ? "按 Enter 输入选项之外的背景或要求" : "Press Enter to add context not covered above");
		const other = this.language === "zh"
			? { value: "", label: "其他（补充说明）", description: otherDescription, isOther: true }
			: { value: "", label: "Other", description: otherDescription, isOther: true };
		const standard = this.question().options.map((option) => ({ value: option.label, ...option }));
		const custom = [...this.custom()].map((value) => ({
			value,
			label: this.language === "zh" ? `补充：${value}` : `Custom: ${value}`,
			description: this.language === "zh" ? "自定义选项，可用 Space 取消" : "Custom choice; press Space to deselect",
			isCustom: true,
		}));
		return [...standard, ...custom, other];
	}

	private selected(questionId = this.question().id): Set<string> {
		let selected = this.selections.get(questionId);
		if (!selected) {
			selected = new Set();
			this.selections.set(questionId, selected);
		}
		return selected;
	}

	private custom(questionId = this.question().id): Set<string> {
		let custom = this.customSelections.get(questionId);
		if (!custom) {
			custom = new Set();
			this.customSelections.set(questionId, custom);
		}
		return custom;
	}

	private record(question: WorkflowClarificationQuestion, values: string[]): void {
		this.answers.set(question.id, {
			id: question.id,
			prompt: question.prompt,
			answer: values.join(this.language === "zh" ? "；" : "; "),
			selections: values,
			wasCustom: values.some((value) => this.custom(question.id).has(value)),
		});
	}

	private markDirty(questionId = this.question().id): void {
		this.answers.delete(questionId);
		this.notice = undefined;
	}

	private moveQuestion(offset: number): void {
		this.questionIndex = (this.questionIndex + offset + this.questions.length) % this.questions.length;
		this.optionIndex = 0;
		this.notice = undefined;
		this.refresh();
	}

	private advance(): void {
		const nextUnanswered = this.questions.findIndex((question, index) => index > this.questionIndex && !this.answers.has(question.id));
		if (nextUnanswered >= 0) {
			this.questionIndex = nextUnanswered;
			this.optionIndex = 0;
			this.refresh();
			return;
		}
		if (this.questions.every((question) => this.answers.has(question.id))) {
			this.done({ cancelled: false, answers: this.questions.map((question) => this.answers.get(question.id)!) });
			return;
		}
		this.questionIndex = this.questions.findIndex((question) => !this.answers.has(question.id));
		this.optionIndex = 0;
		this.refresh();
	}

	private selectCurrent(): void {
		const question = this.question();
		const option = this.options()[this.optionIndex];
		if (!option) return;
		if (option.isOther) {
			this.editingOther = true;
			this.notice = undefined;
			this.editor.setText("");
			this.refresh();
			return;
		}
		if (question.multiple) {
			const selected = this.selected();
			if (selected.has(option.value)) selected.delete(option.value);
			else selected.add(option.value);
			this.markDirty();
			this.refresh();
			return;
		}
		this.record(question, [option.value]);
		this.advance();
	}

	private submitOther(value: string): void {
		const answer = value.trim();
		if (!answer) {
			this.notice = this.language === "zh" ? "补充内容不能为空" : "Custom context cannot be empty";
			this.refresh();
			return;
		}
		const question = this.question();
		this.custom().add(answer);
		if (question.multiple) {
			this.selected().add(answer);
			this.markDirty();
			this.editingOther = false;
			this.editor.setText("");
			this.optionIndex = Math.max(0, this.options().length - 2);
			this.refresh();
			return;
		}
		this.record(question, [answer]);
		this.editingOther = false;
		this.editor.setText("");
		this.advance();
	}

	private confirmMultiple(): void {
		const values = [...this.selected()];
		if (values.length === 0) {
			this.notice = this.language === "zh" ? "请至少选择一项，或在“其他”中补充" : "Select at least one choice or add Other context";
			this.refresh();
			return;
		}
		this.record(this.question(), values);
		this.notice = undefined;
		this.advance();
	}

	handleInput(data: string): void {
		if (this.editingOther) {
			if (matchesKey(data, Key.escape)) {
				this.editingOther = false;
				this.editor.setText("");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done({ cancelled: true, answers: [] });
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.optionIndex = (this.optionIndex - 1 + this.options().length) % this.options().length;
			this.notice = undefined;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.optionIndex = (this.optionIndex + 1) % this.options().length;
			this.notice = undefined;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.moveQuestion(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.moveQuestion(1);
			return;
		}
		if (data === " " && this.question().multiple) {
			this.selectCurrent();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (this.question().multiple) this.confirmMultiple();
			else this.selectCurrent();
		}
	}

	private tabLabel(question: WorkflowClarificationQuestion, index: number, width: number): string {
		const prompt = question.prompt.replace(/[?？:：。.!！]+$/u, "").trim();
		const label = truncateToWidth(prompt || question.id, Math.max(4, width));
		return ` ${index + 1} ${label} `;
	}

	private selectedSummary(question = this.question()): string {
		const values = question.multiple
			? [...this.selected(question.id)]
			: (this.answers.get(question.id)?.selections ?? []);
		if (values.length === 0) return this.language === "zh" ? "尚未选择" : "Not selected";
		return values.join(this.language === "zh" ? "；" : "; ");
	}

	render(width: number): string[] {
		if (this.cachedLines) return this.cachedLines;
		const safeWidth = Math.max(20, width);
		const question = this.question();
		const title = this.language === "zh" ? "需求确认" : "Research setup";
		const titlePrefix = `${this.theme.fg("border", "─")} ${this.theme.bold(title)} `;
		const lines: string[] = [`${titlePrefix}${this.theme.fg("border", "─".repeat(Math.max(0, safeWidth - visibleWidth(titlePrefix))))}`];
		const tabWidth = Math.max(5, Math.floor((safeWidth - this.questions.length - 1) / this.questions.length) - 3);
		const tabs = this.questions.map((entry, index) => {
			const label = this.tabLabel(entry, index, tabWidth);
			return index === this.questionIndex
				? this.theme.bg("selectedBg", this.theme.fg("text", label))
				: this.theme.fg(this.answers.has(entry.id) ? "text" : "muted", label);
		}).join(" ");
		lines.push(` ${truncateToWidth(tabs, Math.max(1, safeWidth - 1))}`, "");
		const fieldWidth = this.language === "zh" ? 8 : 10;
		const field = (label: string, value: string, color: "text" | "accent" | "muted" = "text") => {
			addWrapped(lines, ` ${this.theme.fg("muted", label.padEnd(fieldWidth))}`, this.theme.fg(color, value), safeWidth);
		};
		field(this.language === "zh" ? "问题" : "Question", this.theme.bold(question.prompt));
		field(this.language === "zh" ? "类型" : "Type", question.multiple
			? (this.language === "zh" ? "多选" : "Multiple choice")
			: (this.language === "zh" ? "单选" : "Single choice"), "muted");
		field(this.language === "zh" ? "已选" : "Selected", this.selectedSummary(), this.selected(question.id).size > 0 || this.answers.has(question.id) ? "accent" : "muted");
		lines.push("");
		for (const [index, option] of this.options().entries()) {
			const focused = index === this.optionIndex;
			const prefix = focused ? this.theme.fg("accent", "> ") : "  ";
			const answerSelections = this.answers.get(question.id)?.selections ?? [];
			const checked = question.multiple
				? (option.isOther ? "   " : this.selected().has(option.value) ? this.theme.fg("success", "[x]") : "[ ]")
				: (option.isOther ? "  " : answerSelections.includes(option.value) ? this.theme.fg("success", "●") : "○");
			addWrapped(lines, prefix, `${checked} ${focused ? this.theme.fg("accent", option.label) : option.label}`, safeWidth);
			if (option.description) addWrapped(lines, "      ", this.theme.fg("muted", option.description), safeWidth);
		}
		if (this.editingOther) {
			lines.push("");
			addWrapped(lines, " ", this.theme.fg("muted", this.language === "zh" ? "补充说明" : "Other context"), safeWidth);
			for (const line of this.editor.render(Math.max(1, safeWidth - 2))) lines.push(` ${line}`);
		}
		if (this.notice) {
			lines.push("");
			addWrapped(lines, " ", this.theme.fg("warning", this.notice), safeWidth);
		}
		lines.push("");
		const footer = this.editingOther
			? (this.language === "zh" ? "Enter 保存补充 · Esc 返回表单" : "Enter save context · Esc return to form")
			: question.multiple
				? (this.language === "zh" ? "↑/↓ 移动 · Space 选中/取消或补充 · Enter 提交本题 · Tab/←/→ 切题 · Esc 取消" : "Up/Down move · Space toggle or add Other · Enter submit question · Tab/Left/Right switch · Esc cancel")
				: (this.language === "zh" ? "↑/↓ 移动 · Enter 选择并提交 · Tab/←/→ 切题 · Esc 取消" : "Up/Down move · Enter select and submit · Tab/Left/Right switch · Esc cancel");
		addWrapped(lines, " ", this.theme.fg("dim", footer), safeWidth);
		lines.push(this.theme.fg("border", "─".repeat(safeWidth)));
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}
}

export async function collectWorkflowClarification(
	ctx: ExtensionContext,
	questions: WorkflowClarificationQuestion[],
	language: "zh" | "en",
): Promise<WorkflowClarificationResult | undefined> {
	return ctx.ui.custom<WorkflowClarificationResult | undefined>(
		(tui, theme, _keybindings, done) => new WorkflowClarificationComponent(tui, theme, questions, language, done),
	);
}
