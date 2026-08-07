import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

import type { DocumentOutline } from "../workflows/types.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface WorkflowOutlineReviewResult {
	cancelled: boolean;
	approved: boolean;
	feedback?: string;
}

interface OutlineReviewTui {
	requestRender(): void;
}

function addWrapped(lines: string[], prefix: string, text: string, width: number): void {
	const prefixWidth = visibleWidth(prefix);
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
	for (const [index, line] of wrapped.entries()) lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

function rule(theme: Theme, width: number, label = ""): string {
	if (!label) return theme.fg("border", "─".repeat(Math.max(1, width)));
	const prefix = `${theme.fg("border", "─")} ${label} `;
	return `${prefix}${theme.fg("border", "─".repeat(Math.max(0, width - visibleWidth(prefix))))}`;
}

export class WorkflowOutlineReviewComponent implements Component {
	private readonly tui: OutlineReviewTui;
	private readonly theme: Theme;
	private readonly outline: DocumentOutline;
	private readonly language: "zh" | "en";
	private readonly done: (result: WorkflowOutlineReviewResult) => void;
	private readonly editor: Editor;
	private pageIndex = 0;
	private actionIndex = 0;
	private editingFeedback = false;
	private notice: string | undefined;

	constructor(
		tui: OutlineReviewTui,
		theme: Theme,
		outline: DocumentOutline,
		language: "zh" | "en",
		done: (result: WorkflowOutlineReviewResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.outline = outline;
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
		this.editor.onSubmit = (value) => this.submitFeedback(value);
	}

	private refresh(): void {
		this.tui.requestRender();
	}

	private pageCount(): number {
		return this.outline.sections.length + 1;
	}

	private movePage(offset: number): void {
		this.pageIndex = (this.pageIndex + offset + this.pageCount()) % this.pageCount();
		this.notice = undefined;
		this.refresh();
	}

	private submitFeedback(value: string): void {
		const feedback = value.trim();
		if (!feedback) {
			this.notice = this.language === "zh" ? "请填写需要修改的内容" : "Describe the requested changes";
			this.refresh();
			return;
		}
		this.done({ cancelled: false, approved: false, feedback });
	}

	handleInput(data: string): void {
		if (this.editingFeedback) {
			if (matchesKey(data, Key.escape)) {
				this.editingFeedback = false;
				this.notice = undefined;
				this.editor.setText("");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done({ cancelled: true, approved: false });
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.movePage(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.movePage(1);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.actionIndex = this.actionIndex === 0 ? 1 : 0;
			this.notice = undefined;
			this.refresh();
			return;
		}
		if (!matchesKey(data, Key.enter)) return;
		if (this.actionIndex === 0) {
			this.done({ cancelled: false, approved: true });
			return;
		}
		this.editingFeedback = true;
		this.notice = undefined;
		this.editor.setText("");
		this.refresh();
	}

	private pageTabs(width: number): string {
		const labels = [this.language === "zh" ? "概览" : "Overview", ...this.outline.sections.map((section) => section.title)];
		const maxTabs = Math.max(2, Math.floor(Math.max(1, width - 4) / 18));
		const maxStart = Math.max(0, labels.length - maxTabs);
		const start = Math.min(maxStart, Math.max(0, this.pageIndex - Math.floor(maxTabs / 2)));
		const end = Math.min(labels.length, start + maxTabs);
		const tabs: string[] = [];
		if (start > 0) tabs.push(this.theme.fg("muted", "…"));
		for (let index = start; index < end; index++) {
			const raw = ` ${index + 1} ${truncateToWidth(labels[index]!, 11)} `;
			tabs.push(index === this.pageIndex
				? this.theme.bg("selectedBg", this.theme.fg("text", raw))
				: this.theme.fg("muted", raw));
		}
		if (end < labels.length) tabs.push(this.theme.fg("muted", "…"));
		return tabs.join(" ");
	}

	private field(lines: string[], label: string, value: string, width: number, color: "text" | "accent" | "muted" = "text"): void {
		const fieldWidth = this.language === "zh" ? 8 : 12;
		addWrapped(lines, ` ${this.theme.fg("muted", label.padEnd(fieldWidth))}`, this.theme.fg(color, value), width);
	}

	private renderPage(lines: string[], width: number): void {
		if (this.pageIndex === 0) {
			this.field(lines, this.language === "zh" ? "标题" : "Title", this.outline.title, width, "accent");
			this.field(lines, this.language === "zh" ? "主张" : "Thesis", this.outline.thesis, width);
			this.field(lines, this.language === "zh" ? "章节" : "Sections", String(this.outline.sections.length), width, "muted");
			this.field(lines, this.language === "zh" ? "目标字数" : "Target words", String(this.outline.sections.reduce((sum, section) => sum + section.targetWords, 0)), width, "muted");
			return;
		}
		const section = this.outline.sections[this.pageIndex - 1]!;
		this.field(lines, this.language === "zh" ? "章节" : "Section", `${this.pageIndex}/${this.outline.sections.length} · ${section.title}`, width, "accent");
		this.field(lines, this.language === "zh" ? "目标" : "Objective", section.objective, width);
		this.field(lines, this.language === "zh" ? "字数" : "Words", String(section.targetWords), width, "muted");
		this.field(lines, this.language === "zh" ? "负责人" : "Owner", section.writerNodeId, width, "muted");
		lines.push("");
		addWrapped(lines, " ", this.theme.fg("muted", this.language === "zh" ? "核心问题" : "Questions"), width);
		for (const question of section.questions) addWrapped(lines, "   - ", question, width);
		addWrapped(lines, " ", this.theme.fg("muted", this.language === "zh" ? "证据要求" : "Evidence"), width);
		for (const evidence of section.evidenceRequirements) addWrapped(lines, "   - ", evidence, width);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const lines = [rule(this.theme, safeWidth, this.theme.bold(this.language === "zh" ? "大纲确认" : "Outline review"))];
		lines.push(` ${truncateToWidth(this.pageTabs(safeWidth), Math.max(1, safeWidth - 1))}`, "");
		this.renderPage(lines, safeWidth);
		lines.push("");
		if (this.editingFeedback) {
			addWrapped(lines, " ", this.theme.fg("muted", this.language === "zh" ? "修改意见" : "Revision feedback"), safeWidth);
			for (const line of this.editor.render(Math.max(1, safeWidth - 2))) lines.push(` ${line}`);
		} else {
			const actions = this.language === "zh"
				? [["批准大纲并继续", "Enter 后持久化大纲并进入任务规划"], ["提出修改意见", "输入反馈后返回 Supervisor 重新生成大纲"]]
				: [["Approve and continue", "Enter persists the outline and unlocks planning"], ["Request changes", "Send feedback to the Supervisor for another draft"]];
			for (const [index, action] of actions.entries()) {
				const focused = index === this.actionIndex;
				lines.push(`${focused ? this.theme.fg("accent", ">") : " "} ${focused ? this.theme.fg("accent", action[0]!) : action[0]!}`);
				addWrapped(lines, "   ", this.theme.fg("muted", action[1]!), safeWidth);
			}
		}
		if (this.notice) lines.push("", ` ${this.theme.fg("warning", this.notice)}`);
		lines.push("");
		const footer = this.editingFeedback
			? (this.language === "zh" ? "Enter 提交修改意见 · Esc 返回" : "Enter submit feedback · Esc return")
			: (this.language === "zh" ? "↑/↓ 选择操作 · Enter 提交 · Tab/←/→ 查看章节 · Esc 取消" : "Up/Down choose action · Enter submit · Tab/Left/Right inspect sections · Esc cancel");
		addWrapped(lines, " ", this.theme.fg("dim", footer), safeWidth);
		lines.push(rule(this.theme, safeWidth));
		return lines.map((line) => truncateToWidth(line, safeWidth));
	}

	invalidate(): void {}
}

export async function collectWorkflowOutlineReview(
	ctx: ExtensionContext,
	outline: DocumentOutline,
	language: "zh" | "en",
): Promise<WorkflowOutlineReviewResult | undefined> {
	return ctx.ui.custom<WorkflowOutlineReviewResult | undefined>(
		(tui, theme, _keybindings, done) => new WorkflowOutlineReviewComponent(tui, theme, outline, language, done),
	);
}
