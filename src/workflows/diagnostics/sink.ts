/**
 * Non-authoritative best-effort diagnostic sidecar sink (T6 Phase 1).
 *
 * The sink writes a run-local sidecar append-only JSONL of
 * `WorkflowDiagnosticEventV1` records. Diagnostic observations are **never**
 * authoritative: they do not participate in workflow state transitions and
 * must never become a second state machine. Every write is best-effort — an
 * internal failure or write failure is counted and surfaced on the returned
 * result, but it must never block or throw into the surrounding workflow.
 *
 * Behavior guarantees:
 *  - **one JSON object per line**, written with mode `0600`;
 *  - **monotonic sequence** allocation, resuming from the last valid tail;
 *  - **deterministic `eventId`** via
 *    `sha256(schemaVersion|workflowId|sourceEventId|eventType|payloadVersion)`;
 *  - **idempotent dedup**: re-appending an already-written eventId is a no-op;
 *  - **hash chain**: each record carries `integrity.previousHash` (hash of the
 *    previous valid record) and `integrity.hash` (canonical record hash);
 *  - **corruption tolerance**: a corrupted final line is skipped (and counted)
 *    instead of failing, so a torn tail never blocks later writes;
 *  - **best-effort only**: internal corruption and write failures are counted
 *    as non-fatal and never rethrown (unless `throwOnWriteFailure` is set).
 *
 * Privacy: the sink only persists the envelope passed to `append`. Callers are
 * responsible for projecting allowlist-safe attributes before calling; the sink
 * additionally rejects records that violate the metadata-only invariant via
 * `assertAllowlistSafety`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
	DIAGNOSTIC_PAYLOAD_VERSION,
	DIAGNOSTIC_SCHEMA_VERSION,
	type WorkflowDiagnosticEventV1,
} from "./types.ts";
import {
	assertAllowlistSafety,
	canonicalRecordHash,
	deterministicEventId,
} from "./redaction.ts";

export interface DiagnosticSinkOptions {
	/** Absolute path of the sidecar JSONL file. */
	filePath: string;
	/** Per-install salt used for the integrity hash chain. */
	salt: string;
	/** Drop-and-count records whose serialized byte length exceeds this. */
	maxRecordBytes?: number;
	/** When true, write failures rethrow instead of being counted as non-fatal. */
	throwOnWriteFailure?: boolean;
	/** Clock override for tests; defaults to `Date.now`. */
	now?: () => number;
}

export interface DiagnosticSinkStats {
	/** Records successfully appended (new eventIds). */
	appended: number;
	/** Events ignored because the deterministic eventId was already written. */
	deduplicated: number;
	/** Non-fatal OS/filesystem write failures (the record was not persisted). */
	writeFailures: number;
	/** Non-fatal internal errors (corrupt records, safety violations, oversized). */
	internalFailures: number;
	/** Corrupt JSON lines skipped while scanning an existing tail. */
	corruptedLinesSkipped: number;
	/** Records dropped because they exceeded `maxRecordBytes`. */
	droppedOversized: number;
	/** Highest sequence currently persisted (or -1 when the log is empty). */
	lastSequence: number;
	/** Hash of the last valid persisted record, when any. */
	lastHash?: string;
}

export type AppendStatus = "appended" | "duplicate" | "dropped" | "write_failed" | "rejected";

export interface AppendResult {
	status: AppendStatus;
	eventId: string;
	sequence: number;
	reason?: string;
}

/** Input accepted by the sink; `sequence`/`integrity` are always overwritten. */
export type DiagnosticAppendInput = Omit<WorkflowDiagnosticEventV1, "sequence" | "integrity"> &
	Partial<Pick<WorkflowDiagnosticEventV1, "sequence" | "integrity">>;

interface TailState {
	eventIds: Set<string>;
	lastSequence: number;
	lastHash?: string;
	corruptedLinesSkipped: number;
}

function assertFilePath(filePath: string): void {
	if (!path.isAbsolute(filePath)) {
		throw new Error(`Diagnostic sink requires an absolute file path, got '${filePath}'.`);
	}
}

/**
 * Scans an existing sidecar log, tolerating corrupt lines (especially a torn
 * tail). Returns the set of already-written eventIds, the highest valid
 * sequence, and the hash of the last valid record. A corrupt line is skipped
 * and counted; it never aborts the scan.
 */
export function readDiagnosticSinkTail(filePath: string): TailState {
	const state: TailState = {
		eventIds: new Set(),
		lastSequence: -1,
		corruptedLinesSkipped: 0,
	};
	if (!fs.existsSync(filePath)) return state;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		// A log we cannot read is treated as empty; the caller counts the write
		// failure path if it re-appends. Best-effort by design.
		return state;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			state.corruptedLinesSkipped += 1;
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			state.corruptedLinesSkipped += 1;
			continue;
		}
		const record = parsed as Partial<WorkflowDiagnosticEventV1>;
		if (typeof record.eventId === "string" && record.eventId.length > 0) {
			state.eventIds.add(record.eventId);
		}
		if (typeof record.sequence === "number" && Number.isInteger(record.sequence) && record.sequence >= 0) {
			if (record.sequence > state.lastSequence) {
				state.lastSequence = record.sequence;
				if (record.integrity && typeof record.integrity.hash === "string") {
					state.lastHash = record.integrity.hash;
				}
			}
		}
	}
	return state;
}

/**
 * Best-effort sidecar diagnostic sink. Create one per sidecar file and reuse
 * it for the lifetime of the run so dedup state and the hash chain stay in
 * memory.
 */
export class DiagnosticSink {
	private readonly filePath: string;
	private readonly salt: string;
	private readonly maxRecordBytes: number;
	private readonly throwOnWriteFailure: boolean;
	private readonly now: () => number;

	private readonly eventIds: Set<string>;
	private lastSequence: number;
	private lastHash?: string;
	private readonly stats: DiagnosticSinkStats;

	constructor(options: DiagnosticSinkOptions) {
		assertFilePath(options.filePath);
		this.filePath = options.filePath;
		this.salt = options.salt;
		this.maxRecordBytes = options.maxRecordBytes ?? 16 * 1024;
		this.throwOnWriteFailure = options.throwOnWriteFailure ?? false;
		this.now = options.now ?? Date.now;

		const tail = readDiagnosticSinkTail(this.filePath);
		this.eventIds = tail.eventIds;
		this.lastSequence = tail.lastSequence;
		this.lastHash = tail.lastHash;
		this.stats = {
			appended: 0,
			deduplicated: 0,
			writeFailures: 0,
			internalFailures: 0,
			corruptedLinesSkipped: tail.corruptedLinesSkipped,
			droppedOversized: 0,
			lastSequence: tail.lastSequence,
			lastHash: tail.lastHash,
		};
	}

	get statsSnapshot(): DiagnosticSinkStats {
		return { ...this.stats, lastSequence: this.lastSequence, lastHash: this.lastHash };
	}

	private recordInternalFailure(): void {
		this.stats.internalFailures += 1;
	}

	/**
	 * Appends one diagnostic record. Best-effort: returns a status instead of
	 * throwing for corruption/write failures. The eventId and integrity fields
	 * are computed deterministically and overwrite any caller-provided values.
	 */
	append(input: DiagnosticAppendInput): AppendResult {
		// Safety gate first: a record that violates the metadata-only invariant
		// is rejected outright (it must never reach disk).
		const safety = assertAllowlistSafety(input);
		if (!safety.ok) {
			this.recordInternalFailure();
			return { status: "rejected", eventId: "", sequence: -1, reason: safety.reason };
		}

		const workflowId = input.scope?.workflowId ?? "";
		const sourceEventId = input.correlation?.sourceEventId ?? "";
		const eventId = deterministicEventId({
			schemaVersion: input.schemaVersion ?? DIAGNOSTIC_SCHEMA_VERSION,
			workflowId,
			sourceEventId,
			eventType: input.eventType,
			payloadVersion: input.payloadVersion ?? DIAGNOSTIC_PAYLOAD_VERSION,
		});

		// Idempotent dedup across the full log.
		if (this.eventIds.has(eventId)) {
			this.stats.deduplicated += 1;
			return { status: "duplicate", eventId, sequence: this.lastSequence };
		}

		const sequence = this.lastSequence + 1;
		const record: WorkflowDiagnosticEventV1 = {
			...input,
			schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
			payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
			eventId,
			sequence,
			integrity: {
				previousHash: this.lastHash,
				hash: "",
			},
		};
		record.integrity.hash = canonicalRecordHash(record, this.salt);

		const serialized = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(serialized, "utf-8") > this.maxRecordBytes) {
			this.recordInternalFailure();
			this.stats.droppedOversized += 1;
			return { status: "dropped", eventId, sequence, reason: `record exceeds maxRecordBytes (${this.maxRecordBytes})` };
		}

		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.appendFileSync(this.filePath, serialized, { encoding: "utf-8", mode: 0o600 });
		} catch (error) {
			this.stats.writeFailures += 1;
			if (this.throwOnWriteFailure) {
				throw error;
			}
			return { status: "write_failed", eventId, sequence, reason: String(error) };
		}

		this.eventIds.add(eventId);
		this.lastSequence = sequence;
		this.lastHash = record.integrity.hash;
		this.stats.appended += 1;
		this.stats.lastSequence = sequence;
		this.stats.lastHash = record.integrity.hash;
		return { status: "appended", eventId, sequence };
	}
}

/** Convenience: create a sink pointed at a JSONL file inside a sidecar dir. */
export function createDiagnosticSink(
	dir: string,
	fileName: string,
	options: { salt: string; maxRecordBytes?: number; throwOnWriteFailure?: boolean; now?: () => number },
): DiagnosticSink {
	return new DiagnosticSink({ filePath: path.join(dir, fileName), ...options });
}
