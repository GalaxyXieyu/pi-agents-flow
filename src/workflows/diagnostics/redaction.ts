/**
 * Allowlist-first redaction for workflow diagnostics (T6 Phase 0).
 *
 * Privacy model:
 *  - Every diagnostic is a typed projection of **safe** fields. No function here
 *    accepts an arbitrary `unknown` result object or spreads runtime metadata.
 *  - Forbidden keys are rejected case-insensitively so prompts, tasks, outputs,
 *    tool args, environment values, tokens, and raw paths can never leak.
 *  - Known errors map to stable codes at the source. Unknown errors are
 *    normalized, secret-bearing patterns are redacted, the bounded result is
 *    fingerprinted with a local installation salt, and a redaction count is
 *    reported — the redacted substrings themselves are never persisted.
 *
 * This module is pure (no I/O) and imports no workflow state.
 */
import { createHash, randomBytes } from "node:crypto";

import { DIAGNOSTIC_SCHEMA_ID, DIAGNOSTIC_SCHEMA_VERSION, DIAGNOSTIC_PAYLOAD_VERSION } from "./types.ts";
import type { DiagnosticCode, WorkflowDiagnosticEventV1, WorkflowDiagnosticAttribute } from "./types.ts";

/** Maximum size (UTF-8 bytes) of a redacted `safeSummary`. */
export const MAX_REDACTED_SUMMARY_BYTES = 256;

/**
 * Forbidden attribute/field keys (case-insensitive). These names are reserved
 * because they are the raw-content and secret carriers the diagnostic contract
 * must never persist.
 */
export const FORBIDDEN_KEYS = [
	"prompt",
	"task",
	"instructions",
	"goal",
	"message",
	"content",
	"output",
	"stdout",
	"stderr",
	"args",
	"command",
	"env",
	"header",
	"authorization",
	"cookie",
	"token",
	"secret",
	"password",
	"key",
	"credential",
	"query",
	"url",
	"path",
	"cwd",
] as const;

const FORBIDDEN_KEYS_LOWERCASE = new Set(FORBIDDEN_KEYS.map((key) => key.toLowerCase()));

/**
 * Narrow safe fields explicitly named in the schema/contract. These are
 * permitted even though they embed a forbidden stem, because they carry a
 * bounded measure rather than raw content (e.g. `outputBytes`, `inputTokens`,
 * `usageCostUsd`). The allowlist is the authority: any other key that contains
 * a forbidden stem remains forbidden.
 */
const SAFE_ATTRIBUTE_KEYS = new Set([
	"outputbytes",
	"inputbytes",
	"inputtokens",
	"outputtokens",
	"cachereadtokens",
	"cachewritetokens",
	"usagecostusd",
	"durationms",
	"queuems",
	"attempts",
	"attemptnumber",
	"turncount",
	"toolcallcount",
	"concurrency",
	"retries",
	"bytes",
	"sizebytes",
]);

function stripKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Sources whose `safeSummary` is absent by default regardless of content. */
const SECRET_PRONE_SOURCES = new Set([
	"provider",
	"tool",
	"shell",
	"transcript",
	"structured_output",
	"child",
	"request",
	"env",
]);

/** Stable redaction rule identifiers for observability (never the substrings). */
export const RedactionRule = {
	CREDENTIAL_PATTERN: "redaction.credential_pattern",
	BEARER_AUTH: "redaction.bearer_auth",
	BASIC_AUTH: "redaction.basic_auth",
	API_KEY: "redaction.api_key",
	SIGNED_URL_QUERY: "redaction.signed_url_query",
	EMAIL: "redaction.email",
	HOME_DIRECTORY: "redaction.home_directory",
	HIGH_ENTROPY_TOKEN: "redaction.high_entropy_token",
	FORBIDDEN_KEY: "redaction.forbidden_key",
	RAW_PATH: "redaction.raw_path",
	OVERLONG: "redaction.overlong",
} as const;

export type RedactionRule = (typeof RedactionRule)[keyof typeof RedactionRule];

/**
 * Checks whether a key is forbidden in diagnostic attributes/fields.
 * Case-insensitive and separator-insensitive. A key is forbidden when it is a
 * raw-content/secret carrier:
 *  - an exact forbidden word (`Prompt`, `Authorization`, `apiKey`), or
 *  - a composite whose stem is a forbidden word and which is NOT a narrow safe
 *    measure (so `outputBytes`/`inputTokens` are allowed while `prompt_text`
 *    or `toolArgs` remain forbidden).
 */
export function isForbiddenKey(key: string): boolean {
	const exact = key.toLowerCase();
	if (FORBIDDEN_KEYS_LOWERCASE.has(exact)) return true;
	const normalized = stripKey(key);
	// Explicitly-named narrow safe fields are allowed even when they embed a
	// forbidden stem.
	if (SAFE_ATTRIBUTE_KEYS.has(normalized)) return false;
	return [...FORBIDDEN_KEYS_LOWERCASE].some((forbidden) => normalized.includes(stripKey(forbidden)));
}

/**
 * Safely project a set of explicit safe attributes, dropping any key that
 * matches the forbidden set. Returns the projected map plus the number of keys
 * dropped. Never accepts an arbitrary runtime object.
 */
export function projectSafeAttributes(
	source: Record<string, WorkflowDiagnosticAttribute>,
): { attributes: Record<string, WorkflowDiagnosticAttribute>; redactionCount: number } {
	const attributes: Record<string, WorkflowDiagnosticAttribute> = {};
	let redactionCount = 0;
	for (const [key, value] of Object.entries(source)) {
		if (isForbiddenKey(key)) {
			redactionCount += 1;
			continue;
		}
		attributes[key] = value;
	}
	return { attributes, redactionCount };
}

const HEX_TOKEN = /\b[0-9a-fA-F]{24,}\b/g;
const BASE64_TOKEN = /\b[A-Za-z0-9+/]{32,}={0,2}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const API_KEY_PATTERN = /\b(api[_-]?key|apikey|access[_-]?token)\b[=:]\s*[A-Za-z0-9._~-]{6,}/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const HOME_PATTERN = /(\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+)/g;
const SIGNED_URL_QUERY_PATTERN = /([?&](?:X-Amz-Signature|X-Goog-Signature|sig|signature)=)[^&\s]+/gi;

const KNOWN_ERROR_TO_CODE: Array<[RegExp, string]> = [
	[/quota/i, "error.provider.quota"],
	[/rate\s*limit|throttl/i, "error.provider.rate_limited"],
	[/unauthorized|authentication|invalid (api )?key|permission denied/i, "error.provider.auth"],
	[/unavailable|timeout|timed out|deadline/i, "error.provider.unavailable"],
	[/stream/i, "error.provider.stream"],
	[/transport|network|connection|socket/i, "error.provider.transport"],
	[/structured output|output schema|validation failed|schema/i, "error.contract.schema"],
	[/failed to parse|json parse|malformed/i, "error.contract.parse"],
	[/not found|enoent/i, "error.filesystem.not_found"],
	[/process terminated|killed|sig/i, "error.process.terminated"],
	[/budget|exhausted|max turns|max tools/i, "error.agent.budget"],
];

/** Fallback codes for unknown errors that carry no sensitive detail. */
const UNKNOWN_ERROR_CODE = "error.unknown";
const UNKNOWN_ERROR_CODE_EMPTY = "error.empty";

/**
 * Maps a known error message to a stable machine code. Unknown errors return a
 * generic fallback code; this never embeds the error text as a code.
 */
export function mapErrorToStableCode(error: string | undefined | null): string {
	if (error === undefined || error === null || error.trim() === "") return UNKNOWN_ERROR_CODE_EMPTY;
	for (const [pattern, code] of KNOWN_ERROR_TO_CODE) {
		if (pattern.test(error)) return code;
	}
	return UNKNOWN_ERROR_CODE;
}

/**
 * Normalizes and redacts an error string into a bounded `safeSummary`, and
 * returns the redaction rule id that first matched. `safeSummary` is omitted
 * (undefined) entirely for secret-prone `source` values.
 */
export function redactErrorMessage(
	raw: string,
	opts: { source?: string; salt: string } = { salt: "unset" },
): { safeSummary?: string; code: string; fingerprint: string; redactionCount: number } {
	let summary = typeof raw === "string" ? raw : String(raw);
	let redactionCount = 0;
	const ruleCounts = new Map<RedactionRule, number>();

	const track = (rule: RedactionRule, matches: number): void => {
		if (matches <= 0) return;
		redactionCount += matches;
		ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + matches);
	};

	// Home directories and user names first so later token rules do not match
	// inside the sanitized text.
	const homeMatches = summary.match(HOME_PATTERN)?.length ?? 0;
	if (homeMatches > 0) {
		summary = summary.replace(HOME_PATTERN, "<home>");
		track(RedactionRule.HOME_DIRECTORY, homeMatches);
	}

	const bearerMatches = summary.match(BEARER_PATTERN)?.length ?? 0;
	if (bearerMatches > 0) {
		summary = summary.replace(BEARER_PATTERN, "Bearer <redacted>");
		track(RedactionRule.BEARER_AUTH, bearerMatches);
	}

	const basicMatches = summary.match(BASIC_PATTERN)?.length ?? 0;
	if (basicMatches > 0) {
		summary = summary.replace(BASIC_PATTERN, "Basic <redacted>");
		track(RedactionRule.BASIC_AUTH, basicMatches);
	}

	const apiMatches = summary.match(API_KEY_PATTERN)?.length ?? 0;
	if (apiMatches > 0) {
		summary = summary.replace(API_KEY_PATTERN, "$1 <redacted>");
		track(RedactionRule.API_KEY, apiMatches);
	}

	const signedMatches = summary.match(SIGNED_URL_QUERY_PATTERN)?.length ?? 0;
	if (signedMatches > 0) {
		summary = summary.replace(SIGNED_URL_QUERY_PATTERN, "$1<redacted>");
		track(RedactionRule.SIGNED_URL_QUERY, signedMatches);
	}

	const emailMatches = summary.match(EMAIL_PATTERN)?.length ?? 0;
	if (emailMatches > 0) {
		summary = summary.replace(EMAIL_PATTERN, "<email>");
		track(RedactionRule.EMAIL, emailMatches);
	}

	// Generic high-entropy tokens after specific auth patterns have been cleaned.
	const hexMatches = summary.match(HEX_TOKEN)?.length ?? 0;
	if (hexMatches > 0) {
		summary = summary.replace(HEX_TOKEN, "<token>");
		track(RedactionRule.HIGH_ENTROPY_TOKEN, hexMatches);
	}
	const base64Matches = summary.match(BASE64_TOKEN)?.length ?? 0;
	if (base64Matches > 0) {
		summary = summary.replace(BASE64_TOKEN, "<token>");
		track(RedactionRule.HIGH_ENTROPY_TOKEN, base64Matches);
	}

	// A bare credential-looking pair such as `password: xyz` catches the rest.
	const credentialMatches = summary.match(/(password|secret|token|credential|apiKey|authorization)\s*[:=]\s*[^,\s;]+/gi)?.length ?? 0;
	if (credentialMatches > 0) {
		summary = summary.replace(/(password|secret|token|credential|apiKey|authorization)\s*[:=]\s*[^,\s;]+/gi, "$1 <redacted>");
		track(RedactionRule.CREDENTIAL_PATTERN, credentialMatches);
	}

	// Bound to 256 UTF-8 bytes at the code-unit boundary without splitting a multibyte char.
	if (Buffer.byteLength(summary, "utf-8") > MAX_REDACTED_SUMMARY_BYTES) {
		let truncated = summary;
		while (Buffer.byteLength(truncated, "utf-8") > MAX_REDACTED_SUMMARY_BYTES && truncated.length > 0) {
			truncated = truncated.slice(0, -1);
		}
		truncated = `${truncated}…`;
		redactionCount += 1;
		ruleCounts.set(RedactionRule.OVERLONG, (ruleCounts.get(RedactionRule.OVERLONG) ?? 0) + 1);
		summary = truncated;
	}

	const code = mapErrorToStableCode(raw);
	const sourceKey = (opts.source ?? "").toLowerCase();
	const suppressSummary = SECRET_PRONE_SOURCES.has(sourceKey);
	// A provider/tool/shell/transcript error summary is redaction-safe only if it
	// survived with zero redactions; otherwise it is suppressed to avoid any risk.
	const safe = !suppressSummary;

	return {
		...((safe && redactionCount === 0) || sourceKey === "" ? { safeSummary: summary } : { safeSummary: undefined }),
		code,
		fingerprint: saltedFingerprint(summary, opts.salt),
		redactionCount,
	};
}

/** SHA-256 fingerprint salted with a local installation salt. Deterministic per salt. */
export function saltedFingerprint(value: string, salt: string): string {
	return createHash("sha256").update(`${salt}::${value}`).digest("hex");
}

/**
 * Deterministic diagnostic event id for replayable observations, matching the
 * design: sha256(schemaVersion|workflowId|sourceEventId|eventType|payloadVersion).
 */
export function deterministicEventId(params: {
	schemaVersion: number;
	workflowId: string;
	sourceEventId: string;
	eventType: string;
	payloadVersion: number;
}): string {
	return createHash("sha256")
		.update(
			[
				params.schemaVersion,
				params.workflowId,
				params.sourceEventId,
				params.eventType,
				params.payloadVersion,
			].join("|"),
		)
		.digest("hex");
}

/**
 * Computes the canonical record hash for the diagnostic hash chain
 * (tamper evidence, not authentication). Deterministic over the stable envelope
 * fields; a per-install salt is appended so cross-run rollups cannot collide on
 * identical event payloads.
 */
export function canonicalRecordHash(event: Omit<WorkflowDiagnosticEventV1, "integrity">, salt: string): string {
	const record = JSON.stringify({
		schema: event.schema,
		schemaVersion: event.schemaVersion,
		payloadVersion: event.payloadVersion,
		eventId: event.eventId,
		eventType: event.eventType,
		sequence: event.sequence,
		observedAt: event.observedAt,
		severity: event.severity,
		disposition: event.disposition,
		outcome: event.outcome,
		scope: event.scope,
		correlation: event.correlation,
		classification: event.classification,
		attributes: event.attributes,
		measurements: event.measurements,
		links: event.links,
		error: event.error,
	});
	return createHash("sha256").update(`${salt}::${record}`).digest("hex");
}

/**
 * Validates that a proposed diagnostic event satisfies the metadata-only
 * privacy invariant: forbidden keys never appear in attributes/measurements,
 * and links never carry a materialized path field.
 */
export function assertAllowlistSafety(event: Partial<WorkflowDiagnosticEventV1>): { ok: true } | { ok: false; reason: string } {
	if (event.attributes) {
		for (const key of Object.keys(event.attributes)) {
			if (isForbiddenKey(key)) {
				return { ok: false, reason: `attribute key '${key}' is forbidden` };
			}
		}
	}
	if (event.measurements) {
		for (const key of Object.keys(event.measurements)) {
			if (isForbiddenKey(key)) {
				return { ok: false, reason: `measurement key '${key}' is forbidden` };
			}
		}
	}
	if (event.links) {
		for (const link of event.links) {
			if ("path" in link && typeof (link as { path?: unknown }).path === "string") {
				return { ok: false, reason: "link must not carry a materialized path" };
			}
		}
	}
	if (event.scope?.childRunIdHash && !/^[a-f0-9]{64}$/.test(event.scope.childRunIdHash)) {
		return { ok: false, reason: "childRunIdHash must be a sha256 hex digest" };
	}
	return { ok: true };
}

/**
 * Returns a fresh per-install salt. In Phase 0 callers may persist it in the
 * run-local audit; it must never be exported into cross-run rollups.
 */
export function generateDiagnosticSalt(): string {
	return randomBytes(32).toString("hex");
}

/** Constant schema identifier reused by redaction and audit tooling. */
export const DIAGNOSTIC_SCHEMA_IDENTIFIER = DIAGNOSTIC_SCHEMA_ID;
export const DIAGNOSTIC_ENVELOPE_VERSION = DIAGNOSTIC_SCHEMA_VERSION;
export const DIAGNOSTIC_PAYLOAD_VERSION_CONST = DIAGNOSTIC_PAYLOAD_VERSION;
