import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";
import { checkModelScope, type ModelScopeConfig, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	if (baseModel.includes("/")) {
		const exact = availableModels.find((entry) => entry.fullId === baseModel);
		if (exact) return exact.fullId;
	} else {
		const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
		if (preferredProvider) {
			const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
			if (preferredMatch) return preferredMatch.fullId;
		}
		if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	let queryProvider: string | undefined;
	let queryIdRaw = baseModel;
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
		queryIdRaw = baseModel.slice(slashIdx + 1);
	} else {
		const providerSeparators = [":", "."];
		for (const separator of providerSeparators) {
			const separatorIdx = baseModel.indexOf(separator);
			if (separatorIdx <= 0) continue;
			const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
			if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart)) continue;
			queryProvider = providerPart;
			queryIdRaw = baseModel.slice(separatorIdx + 1);
			break;
		}
	}
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeConfig;
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-agents-flow] ${violation.message}`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	let resolved: string | undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
	}
	if (resolved && options?.scope?.enforce) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		const violation = checkModelScope(resolved, options.scope, source);
		if (violation) {
			if (violation.severity === "error") throw new Error(violation.message);
			(options.onWarn ?? defaultScopeWarn)(violation);
		}
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: Omit<ResolveSubagentModelOverrideOptions, "source">,
): string | undefined {
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: explicitModel !== undefined ? "explicit" : "inherited" },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: "inherited" },
	);
}

export interface BuildModelCandidatesOptions {
	/** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
	scope?: ModelScopeConfig;
	onWarn?: (violation: ModelScopeViolation) => void;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		if (index > 0 && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "inherited");
			if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

export type WorkflowFailureClass =
	| "provider_quota_exhausted"
	| "provider_auth_failed"
	| "provider_rate_limited"
	| "provider_unavailable"
	| "provider_stream_failed"
	| "provider_transport_failed"
	| "process_terminated"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "timeout"
	| "invalid_result"
	| "output_registration_failed"
	| "preflight_failed"
	| "cancelled"
	| "task_failed";

export interface WorkflowFailureClassification {
	failureClass: WorkflowFailureClass;
	/** Whether rerunning the same immutable workflow node is reasonable. */
	retryable: boolean;
	/** Whether the low-level runner may try another configured model candidate. */
	modelFallbackRetryable: boolean;
	/** Provider/account failures pause queued workflow work until intervention. */
	pauseWorkflow: boolean;
	suggestedAction: string;
}

export interface WorkflowFailureContext {
	status?: string;
	stage?: "preflight" | "transport";
	failureClass?: WorkflowFailureClass;
}

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

function classified(
	failureClass: WorkflowFailureClass,
	retryable: boolean,
	modelFallbackRetryable: boolean,
	pauseWorkflow: boolean,
	suggestedAction: string,
): WorkflowFailureClassification {
	return { failureClass, retryable, modelFallbackRetryable, pauseWorkflow, suggestedAction };
}

/**
 * Convert provider/process terminal text into a durable workflow disposition.
 * String matching is a compatibility fallback; callers should pass structured
 * status/stage hints whenever the delegation protocol supplies them.
 */
export function classifyWorkflowFailure(error: string | undefined, context: WorkflowFailureContext = {}): WorkflowFailureClassification {
	const message = error?.trim() ?? "";
	const status = context.status?.toLowerCase();
	if (context.failureClass === "output_registration_failed") {
		return classified("output_registration_failed", false, false, false, "Inspect the output contract or artifact store, then create a corrected replacement node.");
	}
	if (
		context.failureClass === "invalid_result"
		|| status === "structured_output_failed"
		|| status === "invalid_request"
		|| /(?:invalid structured result|workflow context pack|input binding .+ requires text values|requires .* text media type|declares text\/.+ but .* not text)/i.test(message)
	) {
		return classified("invalid_result", false, false, false, "Inspect retained output and create a corrected replacement node; changing providers alone will not repair the contract.");
	}
	if (status === "turn_budget_exhausted" || /(?:subagent\s+)?exceeded turn budget|turn budget exhausted/i.test(message)) {
		return classified("turn_budget_exhausted", false, false, false, "Inspect retained output, then replace the node with an adequate turn budget or a narrower objective.");
	}
	if (status === "tool_budget_exhausted" || /tool budget exhausted/i.test(message)) {
		return classified("tool_budget_exhausted", false, false, false, "Inspect retained output, then replace the node with an adequate tool budget or a narrower objective.");
	}
	if (TOOL_FAILURE_PREFIX.test(message)) {
		return classified("task_failed", true, false, false, "Inspect the failed tool operation before explicitly retrying this node.");
	}
	if (/\b402\b|insufficient (?:balance|funds?|credit)|(?:provider|api|account|billing)\s+quota(?:\s+(?:exhausted|exceeded))?|quota\s+(?:exhausted|exceeded)|billing (?:failure|error|required)|credit exhausted/i.test(message)) {
		return classified("provider_quota_exhausted", false, false, true, "Add provider balance/quota or create a same-kind replacement node on a different provider/model, then resume the workflow.");
	}
	if (/\b401\b|authentication failed|provider auth(?:entication)? failed|unauthori[sz]ed|invalid api key|api key (?:invalid|expired|missing)|token expired/i.test(message)) {
		return classified("provider_auth_failed", false, false, true, "Repair provider credentials or create a same-kind replacement node on a different provider/model, then resume the workflow.");
	}
	if (/rate\s*limit|too many requests|\b429\b/i.test(message)) {
		return classified("provider_rate_limited", true, true, false, "Wait for the provider retry window or explicitly retry with a different provider/model.");
	}
	if (/stream ended without finish_reason|incomplete stream|stream.*(?:closed|ended|failed)/i.test(message)) {
		return classified("provider_stream_failed", true, true, false, "Retry the node; if the stream failure recurs, replace it with a different provider/model.");
	}
	if (/subagent process terminated|terminated by signal|\bSIG(?:TERM|KILL|ABRT|SEGV)\b/i.test(message)) {
		return classified("process_terminated", false, false, false, "Inspect process/runtime logs and retained output before creating a replacement node.");
	}
	if (status === "timed_out" || /timed? out|timeout|\bETIMEDOUT\b/i.test(message)) {
		return classified("timeout", true, true, false, "Retry once or replace the node with a larger timeout or different provider/model.");
	}
	if (/provider.*unavailable|model.*unavailable|model.*disabled|model.*not found|unknown model|overloaded|service unavailable|temporar(?:ily)? unavailable|\b50[234]\b|model.*(?:load|fail|error)|cold.?start/i.test(message)) {
		return classified("provider_unavailable", false, true, false, "Create a same-kind replacement node using an available model; the original node remains pinned to its recorded model.");
	}
	if (context.stage === "transport" || /connection refused|connection error|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bEAI_AGAIN\b|\bEPIPE\b|fetch failed|network error|socket hang up|upstream|empty response|no output/i.test(message)) {
		return classified("provider_transport_failed", true, true, false, "Retry the node; if transport failures recur, replace it with a different provider/model.");
	}
	if (context.stage === "preflight") {
		return classified("preflight_failed", false, false, false, "Fix the node AgentSpec, model, skills, or tool preflight, then create a corrected replacement node.");
	}
	if (status === "cancelled" || status === "interrupted") {
		return classified("cancelled", true, false, false, "Retry only if the cancellation was intentional or transient.");
	}
	return classified("task_failed", true, false, false, "Inspect the task error and retained artifacts before explicitly retrying this node.");
}

function modelProvider(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const { baseModel } = splitThinkingSuffix(model);
	const slash = baseModel.indexOf("/");
	return slash > 0 ? normalizeModelSegment(baseModel.slice(0, slash)) : undefined;
}

export function isRetryableModelFailure(error: string | undefined, currentModel?: string, nextModel?: string): boolean {
	if (!error) return false;
	const classification = classifyWorkflowFailure(error);
	if (classification.modelFallbackRetryable) return true;
	if (classification.failureClass !== "provider_quota_exhausted" && classification.failureClass !== "provider_auth_failed") return false;
	const currentProvider = modelProvider(currentModel);
	const nextProvider = modelProvider(nextModel);
	return Boolean(currentProvider && nextProvider && currentProvider !== nextProvider);
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
