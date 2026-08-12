import {
	boundedRedactedReason,
	decisionInputDigest,
	type DecisionAuditRecord,
	type DecisionAuditSink,
} from "./decision-audit.ts";

export type HeadlessDecisionVerdict = "approve" | "revise" | "reject" | "pause" | "request-more-evidence";

export interface HeadlessDecisionRequest {
	kind: "clarify" | "outline-review" | "checkpoint" | "confirmation";
	evidence: unknown;
	policyVersion: string;
	traceId: string;
	forbiddenCapabilities: readonly string[];
}

export interface HeadlessDecision {
	verdict: HeadlessDecisionVerdict;
	reason: string;
	confidence: number;
	model: string;
	provider: string;
	structuredAnswer?: unknown;
}

export interface HeadlessDecisionProvider {
	decide(request: HeadlessDecisionRequest, signal?: AbortSignal): Promise<HeadlessDecision>;
}

export interface ExecuteHeadlessDecisionOptions {
	provider: HeadlessDecisionProvider;
	request: HeadlessDecisionRequest;
	audit: DecisionAuditSink;
	approveThreshold: number;
	evidenceSufficient: boolean;
	policyAllowsApproval: boolean;
	timeoutMs: number;
	signal?: AbortSignal;
	now?: () => Date;
	/** Kind-specific approval validation. A reason narrows approval to request-more-evidence before audit. */
	approvalEvidenceIssue?: (decision: HeadlessDecision) => string | undefined;
}

const REQUEST_KINDS = new Set<HeadlessDecisionRequest["kind"]>(["clarify", "outline-review", "checkpoint", "confirmation"]);
const VERDICTS = new Set<HeadlessDecisionVerdict>(["approve", "revise", "reject", "pause", "request-more-evidence"]);
const DECISION_FIELDS = new Set(["verdict", "reason", "confidence", "model", "provider", "structuredAnswer"]);
const GRANT_SHAPED_KEYS = new Set([
	"allowedcapabilities", "allowedpermissions", "allowedtools",
	"capabilities", "capabilitygrant", "capabilitygrants",
	"forbiddencapabilities", "permissiongrant", "permissiongrants", "permissions",
	"privilegegrant", "privilegegrants", "privileges",
	"toolgrant", "toolgrants", "toolpermissions",
]);

function record(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

class SnapshotError extends Error {}

/**
 * Takes exactly one own-descriptor snapshot per object identity and reconstructs
 * a deeply frozen plain value from descriptor values. No property value is ever
 * read from the source object, including when the source is a Proxy.
 */
function descriptorSnapshot(value: unknown, snapshots = new WeakMap<object, unknown>(), ancestors = new WeakSet<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "undefined" || typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new SnapshotError("Provider returned an unsupported decision value.");
		return value;
	}
	if (typeof value !== "object") throw new SnapshotError("Provider returned an unsupported decision value.");

	if (ancestors.has(value)) throw new SnapshotError("Provider returned an unsupported decision value.");
	const prior = snapshots.get(value);
	if (prior !== undefined) return prior;
	ancestors.add(value);

	let prototype: object | null;
	let descriptors: PropertyDescriptorMap;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw new SnapshotError("Provider returned a malformed decision.");
	}
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some((key) => typeof key !== "string")) throw new SnapshotError("Provider returned undeclared decision fields.");

	if (Array.isArray(value)) {
		if (prototype !== Array.prototype) throw new SnapshotError("Provider returned a malformed decision.");
		const lengthDescriptor = descriptors.length;
		if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") throw new SnapshotError("Provider returned a malformed decision.");
		const length = lengthDescriptor.value;
		const unexpected = (keys as string[]).filter((key) => key !== "length" && !(/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < length));
		if (unexpected.length > 0) throw new SnapshotError("Provider returned a malformed decision.");
		const output: unknown[] = new Array(length);
		snapshots.set(value, output);
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new SnapshotError("Provider returned a malformed decision.");
			output[index] = descriptorSnapshot(descriptor.value, snapshots, ancestors);
		}
		ancestors.delete(value);
		return Object.freeze(output);
	}

	if (prototype !== Object.prototype && prototype !== null) throw new SnapshotError("Provider returned a malformed decision.");
	const output: Record<string, unknown> = {};
	snapshots.set(value, output);
	for (const key of keys as string[]) {
		const descriptor = descriptors[key]!;
		if (!("value" in descriptor) || !descriptor.enumerable) throw new SnapshotError("Provider returned a malformed decision.");
		Object.defineProperty(output, key, {
			value: descriptorSnapshot(descriptor.value, snapshots, ancestors),
			enumerable: true,
			writable: false,
			configurable: false,
		});
	}
	ancestors.delete(value);
	return Object.freeze(output);
}

function normalizedSecurityKey(key: string): string {
	return key.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function isGrantShapedKey(key: string): boolean {
	const normalized = normalizedSecurityKey(key);
	if (GRANT_SHAPED_KEYS.has(normalized)) return true;
	const securitySubject = /(?:tool|capabilit|permission|privilege)/u.test(normalized);
	const mutation = /(?:allow|grant|forbid|deny|revoke|enable|disable|assign|override|elevat|escalat|access|update|change|mutat|remove)/u.test(normalized);
	return securitySubject && mutation;
}

function containsPrivilegeMutation(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!record(value) && !Array.isArray(value)) return false;
	if (seen.has(value as object)) return true;
	seen.add(value as object);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some((key) => typeof key !== "string")) return true;
	for (const key of keys as string[]) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return true;
		if (!Array.isArray(value) && isGrantShapedKey(key)) return true;
		if (containsPrivilegeMutation(descriptor.value, seen)) return true;
	}
	return false;
}

function malformedDecisionReason(value: unknown): string | undefined {
	if (!record(value)) return "Provider returned a malformed decision.";
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !DECISION_FIELDS.has(key))) return "Provider returned undeclared decision fields.";
	if (!VERDICTS.has(value.verdict as HeadlessDecisionVerdict)) return "Provider returned an unsupported verdict.";
	if (typeof value.reason !== "string" || !value.reason.trim()) return "Provider returned a decision without a reason.";
	if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return "Provider returned confidence outside [0,1].";
	if (typeof value.model !== "string" || !value.model.trim() || typeof value.provider !== "string" || !value.provider.trim()) return "Provider omitted model or provider identity.";
	return undefined;
}

function immutableDecision(decision: HeadlessDecision, changes: Partial<HeadlessDecision> = {}): HeadlessDecision {
	return Object.freeze({ ...decision, ...changes });
}

function failClosedDecision(verdict: Extract<HeadlessDecisionVerdict, "reject" | "pause" | "request-more-evidence">, reason: string): HeadlessDecision {
	return Object.freeze({ verdict, reason, confidence: 0, model: "unavailable", provider: "unavailable" });
}

export function validateHeadlessDecision(input: unknown, options: Pick<ExecuteHeadlessDecisionOptions, "approveThreshold" | "evidenceSufficient" | "policyAllowsApproval">): HeadlessDecision {
	if (!Number.isFinite(options.approveThreshold) || options.approveThreshold < 0 || options.approveThreshold > 1) throw new Error("approveThreshold must be within [0,1].");
	let snapshot: unknown;
	try {
		snapshot = descriptorSnapshot(input);
	} catch (error) {
		const reason = error instanceof SnapshotError ? error.message : "Provider returned a malformed decision.";
		return failClosedDecision("reject", reason);
	}
	const malformed = malformedDecisionReason(snapshot);
	if (malformed) return failClosedDecision("reject", malformed);
	const decision = snapshot as HeadlessDecision;
	if (containsPrivilegeMutation(decision.structuredAnswer)) {
		return immutableDecision(decision, { verdict: "pause", reason: "Decision attempted to modify platform capability or tool grants." });
	}
	if (decision.verdict !== "approve") return decision;
	if (!options.evidenceSufficient) return immutableDecision(decision, { verdict: "request-more-evidence", reason: "Approval requires sufficient evidence." });
	if (!options.policyAllowsApproval) return immutableDecision(decision, { verdict: "pause", reason: "Approval conflicts with the active policy." });
	if (decision.confidence < options.approveThreshold) return immutableDecision(decision, { verdict: "reject", reason: `Approval confidence is below the ${options.approveThreshold} threshold.` });
	return decision;
}

function linkAbortSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup(): void; timedOut(): boolean } {
	const controller = new AbortController();
	let timeout = false;
	const abortFromParent = (): void => controller.abort(parent?.reason);
	parent?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(() => {
		timeout = true;
		controller.abort(new Error("Headless decision provider timed out."));
	}, timeoutMs);
	return {
		signal: controller.signal,
		cleanup() { clearTimeout(timer); parent?.removeEventListener("abort", abortFromParent); },
		timedOut: () => timeout,
	};
}

export async function executeHeadlessDecision(options: ExecuteHeadlessDecisionOptions): Promise<HeadlessDecision> {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("timeoutMs must be positive.");
	if (!REQUEST_KINDS.has(options.request.kind)) throw new Error("Unsupported headless decision request kind.");
	// Unsupported inputs are rejected before a provider decision exists; therefore
	// there is intentionally no decision audit record for this preflight failure.
	const inputDigest = decisionInputDigest(options.request);
	const abort = linkAbortSignal(options.signal, options.timeoutMs);
	let raw: unknown;
	let failure: string | undefined;
	try {
		raw = await Promise.race([
			options.provider.decide(options.request, abort.signal),
			new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason ?? new Error("Decision aborted.")), { once: true })),
		]);
	} catch {
		failure = abort.timedOut()
			? "Headless decision provider timed out."
			: options.signal?.aborted
				? "Headless decision request was aborted."
				: "Headless decision provider failed.";
	} finally {
		abort.cleanup();
	}
	let decision = failure
		? failClosedDecision("pause", failure)
		: validateHeadlessDecision(raw, options);
	if (decision.verdict === "approve") {
		const evidenceIssue = options.approvalEvidenceIssue?.(decision);
		if (evidenceIssue) decision = immutableDecision(decision, { verdict: "request-more-evidence", reason: evidenceIssue });
	}
	const audit: DecisionAuditRecord = {
		kind: options.request.kind,
		inputDigest,
		verdict: decision.verdict,
		reason: boundedRedactedReason(decision.reason),
		confidence: decision.confidence,
		model: boundedRedactedReason(decision.model, 128),
		provider: boundedRedactedReason(decision.provider, 128),
		policyVersion: boundedRedactedReason(options.request.policyVersion, 128),
		timestamp: (options.now ?? (() => new Date()))().toISOString(),
		traceId: boundedRedactedReason(options.request.traceId, 128),
	};
	await options.audit.write(audit);
	return immutableDecision(decision, { reason: audit.reason });
}
