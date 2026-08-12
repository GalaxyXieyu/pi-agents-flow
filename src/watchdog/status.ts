/**
 * UI-free watchdog status text builder.
 *
 * `buildWatchdogStatus` is used both by the interactive watchdog command
 * (register-main.ts) and by the subagent executor's watchdog tool action
 * (tool-actions.ts). It lives here, UI-free, so the headless subagent runtime
 * never pulls pi-tui into its module graph through the watchdog status path.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveEffectiveThinking, splitKnownThinkingSuffix } from "../shared/model-info.ts";
import { recommendStrongWatchdogModel } from "./model-selection.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";
import type { WatchdogRuntimeStatus } from "./types.ts";

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boolLabel(value: boolean): string {
	return value ? "on" : "off";
}

function statusLabel(status: WatchdogRuntimeStatus): string {
	return status.replaceAll("-", " ");
}

function sourceLine(source: { scope: string; path?: string; exists: boolean }): string {
	const location = source.path ? ` ${source.path}` : "";
	return `- ${source.scope}${location}: ${source.exists ? "found" : "not found"}`;
}

function currentSessionModelLine(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
	if (model && typeof model.provider === "string" && typeof model.id === "string") return `current session (${model.provider}/${model.id})`;
	return "current session (not configured)";
}

function mainThinkingLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const configuredModel = snapshot.config.main.model;
	const configuredThinking = snapshot.config.main.thinking;
	if (configuredModel) {
		const effective = resolveEffectiveThinking(configuredModel, configuredThinking);
		if (effective) return effective;
		return "off (default for explicit watchdog model)";
	}
	if (configuredThinking === false) return "off";
	if (configuredThinking !== undefined) return configuredThinking;
	const currentThinking = (ctx as { thinkingLevel?: unknown }).thinkingLevel;
	return typeof currentThinking === "string" ? `current session (${currentThinking})` : "current session";
}

function mainModelLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	if (snapshot.config.main.model) {
		const source = snapshot.sessionModelOverride?.model ? "session override" : "configured";
		return `Main model: ${splitKnownThinkingSuffix(snapshot.config.main.model).baseModel} (${source})`;
	}
	return `Main model: ${currentSessionModelLine(ctx)}`;
}

function childrenLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const children = snapshot.config.children;
	const model = children.model ? splitKnownThinkingSuffix(children.model).baseModel : "current child session";
	const thinking = children.thinking === undefined ? "current child session" : children.thinking === false ? "off" : children.thinking;
	const overrides = Object.entries(children.overrides);
	const overrideText = overrides.length
		? ` · overrides ${overrides.map(([agent, override]) => {
			const bits = [agent];
			if (override.enabled !== undefined) bits.push(boolLabel(override.enabled));
			if (override.model) bits.push(splitKnownThinkingSuffix(override.model).baseModel);
			if (override.thinking !== undefined) bits.push(`thinking ${override.thinking === false ? "off" : override.thinking}`);
			return bits.join(" ");
		}).join("; ")}`
		: "";
	return `Children: ${boolLabel(snapshot.config.enabled && children.enabled)} · model ${model} · thinking ${thinking}${overrideText}`;
}

function recommendationLine(ctx: ExtensionContext): string {
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		return `Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking} (${recommendation.label}, complementary reviewer)`;
	} catch (error) {
		return `Recommended strong watchdog: unavailable (${messageFromError(error)})`;
	}
}

function lspLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const lsp = snapshot.lsp;
	const provider = lsp.provider ? ` · ${lsp.provider}` : "";
	const counts = lsp.diagnosticCount > 0 || lsp.freshDiagnosticCount > 0
		? ` · ${lsp.freshDiagnosticCount} new/${lsp.diagnosticCount} total`
		: "";
	const message = lsp.message ? ` · ${lsp.message}` : "";
	return `LSP diagnostics: ${lsp.enabled ? "on" : "off"} · ${lsp.status}${provider}${counts}${message}`;
}

export function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const lines = [
		"Subagent watchdog",
		`Main: ${boolLabel(snapshot.enabled)}${!snapshot.config.enabled && snapshot.sessionOverride === undefined ? " (default off)" : ""}`,
		`Runtime: ${statusLabel(snapshot.status)}${snapshot.bufferedDeltas > 0 ? ` · buffered deltas ${snapshot.bufferedDeltas}` : ""}`,
		`Review trigger: ${snapshot.reviewTrigger === "repo-edits" ? "repo edits only" : "every non-empty turn delta"}`,
		`Scope context: ${snapshot.config.scope.enabled ? "on" : "off"}`,
		`Cadence: ${snapshot.config.cadence.everyNTools === null ? "boundary only" : `every ${snapshot.config.cadence.everyNTools} tools + boundary`}`,
		lspLine(snapshot),
		`Session override: ${snapshot.sessionOverride === undefined ? "none" : boolLabel(snapshot.sessionOverride)}`,
		mainModelLine(snapshot, ctx),
		`Main thinking: ${mainThinkingLine(snapshot, ctx)}`,
		childrenLine(snapshot),
		recommendationLine(ctx),
		`Agent-end timeout: ${snapshot.config.agentEndTimeoutMs}ms`,
		`Auto-follow: ${snapshot.enabled && snapshot.config.autoFollow.blockers ? "on for blockers" : "off"} · attempts ${snapshot.autoFollowAttempts}${snapshot.config.autoFollow.maxAttempts === null ? "" : `/${snapshot.config.autoFollow.maxAttempts}`}${snapshot.autoFollowQueued ? " · queued" : ""}${snapshot.autoFollowStalemate ? " · stalemate" : ""}`,
		`Review model call: ${snapshot.reviewDescription}`,
	];
	if (snapshot.failedReviews > 0) lines.push(`Failed reviews: ${snapshot.failedReviews}`);
	if (snapshot.staleReviews > 0) lines.push(`Stale reviews: ${snapshot.staleReviews}`);
	if (snapshot.changedPaths?.length) {
		lines.push(`Changed paths: ${snapshot.changedPaths.slice(0, 8).join(", ")}${snapshot.changedPaths.length > 8 ? `, +${snapshot.changedPaths.length - 8} more` : ""}`);
	}
	if (snapshot.lastWarning) {
		lines.push(`Last warning: ${snapshot.lastWarning.severity} · ${snapshot.lastWarning.state ?? "candidate"} · ${snapshot.lastWarning.summary}`);
	}
	if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`);
	if (!snapshot.configOk) {
		lines.push("", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`), "Watchdog is disabled until the config is fixed.");
	} else {
		lines.push("", "Config: ok");
	}
	lines.push(
		"Sources:",
		...snapshot.sources.map(sourceLine),
		"",
		"Model commands:",
		"- /subagents-watchdog recommend-model",
		"- /subagents-watchdog model recommended",
		"- /subagents-watchdog model <provider/model[:thinking]>",
		"- /subagents-watchdog model inherit",
		"- /subagents-watchdog session model recommended",
		"Agent action: subagent({ action: \"watchdog.configure\", model: \"recommended\", scope: \"session\" })",
	);
	return lines.join("\n");
}
