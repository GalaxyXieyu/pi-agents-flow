import { createHash } from "node:crypto";

import type { HeadlessDecisionRequest, HeadlessDecisionVerdict } from "./decision-contract.ts";

export interface DecisionAuditRecord {
	kind: HeadlessDecisionRequest["kind"];
	inputDigest: string;
	verdict: HeadlessDecisionVerdict;
	reason: string;
	confidence: number;
	model: string;
	provider: string;
	policyVersion: string;
	timestamp: string;
	traceId: string;
}

export interface DecisionAuditSink {
	write(record: DecisionAuditRecord): void | Promise<void>;
}

const SENSITIVE_MARKERS = [
	"apikey",
	"accesstoken",
	"refreshtoken",
	"token",
	"secret",
	"password",
	"authorization",
	"rawprompt",
	"rawevidence",
	"bearer",
] as const;
const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";

function sensitiveDetectionView(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[\p{P}\p{S}\p{Z}\p{C}\s]+/gu, "");
}

function bound(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= TRUNCATED.length) return value.slice(0, max);
	return `${value.slice(0, max - TRUNCATED.length)}${TRUNCATED}`;
}

/**
 * Bounds a string destined for the audit sink and removes common credential and
 * raw-input forms. Detection uses a normalized view, but a match replaces the
 * entire original value so normalization cannot preserve secret material.
 */
export function boundedRedactedReason(value: string, max = 512): string {
	const safeMax = Number.isSafeInteger(max) && max > 0 ? max : 512;
	const flattened = value.replace(/[\r\n\t]+/g, " ").trim();
	const detectionView = sensitiveDetectionView(flattened);
	const redacted = SENSITIVE_MARKERS.some((marker) => detectionView.includes(marker)) ? REDACTED : flattened;
	if (!redacted) return bound("Decision reason unavailable.", safeMax);
	return bound(redacted, safeMax);
}

function unsupported(value: unknown): never {
	const type = value === null ? "null" : typeof value === "object" ? Object.prototype.toString.call(value) : typeof value;
	throw new TypeError(`Unsupported decision digest value: ${type}.`);
}

/**
 * Encodes supported values with explicit type tags and length/count framing.
 * The encoding is injective for the supported domain and independent of object
 * insertion order. Unsupported values throw instead of being stringified away.
 */
function canonicalEncode(value: unknown, ancestors = new WeakSet<object>()): string {
	if (value === null) return "n;";
	if (typeof value === "boolean") return value ? "b:1;" : "b:0;";
	if (typeof value === "string") return `s:${Buffer.byteLength(value, "utf8")}:${value}`;
	if (typeof value === "undefined") return "u;";
	if (typeof value === "bigint") return `i:${value.toString(10)};`;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return unsupported(value);
		return Object.is(value, -0) ? "d:-0;" : `d:${value.toString()};`;
	}
	if (typeof value === "function" || typeof value === "symbol") return unsupported(value);
	if (typeof value !== "object") return unsupported(value);

	if (ancestors.has(value)) return unsupported(value);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const descriptors = Object.getOwnPropertyDescriptors(value);
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return unsupported(value);
			}
			const unexpectedKeys = Reflect.ownKeys(descriptors).filter((key) => key !== "length" && !(typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < value.length));
			if (unexpectedKeys.length > 0) return unsupported(value);
			return `a:${value.length}:[${value.map((entry) => canonicalEncode(entry, ancestors)).join("")}]`;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return unsupported(value);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.some((key) => typeof key !== "string")) return unsupported(value);
		const stringKeys = (keys as string[]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
		let encoded = `o:${stringKeys.length}:{`;
		for (const key of stringKeys) {
			const descriptor = descriptors[key]!;
			if (!("value" in descriptor) || !descriptor.enumerable) return unsupported(value);
			encoded += canonicalEncode(key, ancestors);
			encoded += canonicalEncode(descriptor.value, ancestors);
		}
		return `${encoded}}`;
	} finally {
		ancestors.delete(value);
	}
}

export function decisionInputDigest(request: HeadlessDecisionRequest): string {
	return createHash("sha256").update(canonicalEncode({
		kind: request.kind,
		evidence: request.evidence,
		policyVersion: request.policyVersion,
		traceId: request.traceId,
		forbiddenCapabilities: [...request.forbiddenCapabilities].sort(),
	})).digest("hex");
}
