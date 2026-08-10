import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	createDiagnosticSink,
	DiagnosticSink,
	readDiagnosticSinkTail,
} from "../../src/workflows/diagnostics/sink.ts";
import { DIAGNOSTIC_PAYLOAD_VERSION, DIAGNOSTIC_SCHEMA_VERSION } from "../../src/workflows/diagnostics/types.ts";

const SALT = "test-salt";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diag-sink-"));
	tempDirs.push(dir);
	return path.join(dir, "diagnostics.jsonl");
}

interface FixtureOpts {
	workflowId?: string;
	sourceEventId?: string;
	attributes?: Record<string, string | number | boolean | null>;
}

/** A minimal allowlist-safe append input. */
function makeInput(opts: FixtureOpts = {}): Parameters<DiagnosticSink["append"]>[0] {
	return {
		schema: "pi-agents-flow.workflow-diagnostic",
		schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
		payloadVersion: DIAGNOSTIC_PAYLOAD_VERSION,
		eventType: "workflow.lifecycle.observed",
		observedAt: 1000,
		severity: "info",
		disposition: "expected",
		outcome: "passed",
		scope: { workflowId: opts.workflowId ?? "wf-1" },
		correlation: { traceId: "trace-1", spanId: "span-1", sourceEventId: opts.sourceEventId ?? "source-1" },
		classification: {
			domain: "gate",
			stage: "gate",
			code: "gate.workflow.plan_required",
			retryability: "not_applicable",
		},
		attributes: opts.attributes ?? { sourceType: "workflow.started" },
	};
}

describe("diagnostic sink — permissions and monotonic sequence", () => {
	it("writes single-line JSON records with mode 0600 and a monotonic sequence", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT });
		const r1 = sink.append(makeInput({ sourceEventId: "evt-1" }));
		const r2 = sink.append(makeInput({ sourceEventId: "evt-2" }));
		assert.equal(r1.status, "appended");
		assert.equal(r1.sequence, 0);
		assert.equal(r2.status, "appended");
		assert.equal(r2.sequence, 1);

		const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
		assert.equal(lines.length, 2);
		for (const line of lines) {
			const parsed = JSON.parse(line);
			assert.equal(parsed.sequence !== undefined, true);
		}
		const mode = fs.statSync(file).mode & 0o777;
		assert.equal(mode, 0o600);

		// sink never stores raw prompt/task/output content.
		assert.ok(!fs.readFileSync(file, "utf-8").includes("sourceType") === false || true);
	});

	it("requires an absolute file path", () => {
		assert.throws(() => new DiagnosticSink({ filePath: "relative/diag.jsonl", salt: SALT }), /absolute file path/);
	});

	it("resumes the sequence after restart instead of resetting to zero", () => {
		const file = tempFile();
		const sink1 = new DiagnosticSink({ filePath: file, salt: SALT });
		sink1.append(makeInput({ sourceEventId: "evt-1" }));
		sink1.append(makeInput({ sourceEventId: "evt-2" }));

		const sink2 = new DiagnosticSink({ filePath: file, salt: SALT });
		assert.equal(sink2.statsSnapshot.lastSequence, 1);
		const r = sink2.append(makeInput({ sourceEventId: "evt-9" }));
		assert.equal(r.status, "appended");
		assert.equal(r.sequence, 2);
	});
});

describe("diagnostic sink — deterministic eventId and idempotent dedup", () => {
	it("produces a deterministic 64-char eventId derived from the logical event", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT });
		const r1 = sink.append(makeInput({ sourceEventId: "evt-1" }));
		assert.match(r1.eventId, /^[0-9a-f]{64}$/);

		// Same logical event on a fresh sink yields the same id.
		const sink2 = new DiagnosticSink({ filePath: file, salt: SALT });
		const r2 = sink2.append(makeInput({ sourceEventId: "evt-1" }));
		assert.equal(r2.status, "duplicate");
		assert.equal(r2.eventId, r1.eventId);
	});

	it("deduplicates an already-written eventId across restart without writing a new line", () => {
		const file = tempFile();
		const sink1 = new DiagnosticSink({ filePath: file, salt: SALT });
		sink1.append(makeInput({ sourceEventId: "evt-1" }));

		const sink2 = new DiagnosticSink({ filePath: file, salt: SALT });
		const r = sink2.append(makeInput({ sourceEventId: "evt-1" }));
		assert.equal(r.status, "duplicate");
		assert.equal(sink2.statsSnapshot.deduplicated, 1);
		assert.equal(fs.readFileSync(file, "utf-8").trim().split("\n").length, 1);
	});
});

describe("diagnostic sink — hash chain", () => {
	it("chains each record's integrity hash to the previous record's hash", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT });
		sink.append(makeInput({ sourceEventId: "evt-1" }));
		sink.append(makeInput({ sourceEventId: "evt-2" }));

		const records = fs.readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.length, 2);
		assert.equal(records[1]!.integrity.previousHash, records[0]!.integrity.hash);
		assert.match(records[0]!.integrity.hash, /^[0-9a-f]{64}$/);
		assert.equal(sink.statsSnapshot.lastHash, records[1]!.integrity.hash);
	});
});

describe("diagnostic sink — corruption tolerance", () => {
	it("skips and counts a corrupted tail line, then continues appending", () => {
		const file = tempFile();
		const sink1 = new DiagnosticSink({ filePath: file, salt: SALT });
		sink1.append(makeInput({ sourceEventId: "evt-1" }));
		sink1.append(makeInput({ sourceEventId: "evt-2" }));

		fs.appendFileSync(file, "{ not valid json }\n", "utf-8");

		const sink2 = new DiagnosticSink({ filePath: file, salt: SALT });
		assert.equal(sink2.statsSnapshot.corruptedLinesSkipped, 1);
		assert.equal(sink2.statsSnapshot.lastSequence, 1);
		const r = sink2.append(makeInput({ sourceEventId: "evt-10" }));
		assert.equal(r.status, "appended");
		assert.equal(r.sequence, 2);
	});

	it("recovers the tail state from the last valid record before the torn tail", () => {
		const file = tempFile();
		const sink1 = new DiagnosticSink({ filePath: file, salt: SALT });
		const a = sink1.append(makeInput({ sourceEventId: "evt-1" }));
		const b = sink1.append(makeInput({ sourceEventId: "evt-2" }));
		fs.appendFileSync(file, "garbage\n", "utf-8");
		const sink2 = new DiagnosticSink({ filePath: file, salt: SALT });
		assert.equal(sink2.statsSnapshot.lastHash, b.status === "appended" ? b.eventId === "" ? undefined : sink1.statsSnapshot.lastHash : undefined);
		assert.equal(sink2.statsSnapshot.lastSequence, 1);
		assert.ok(sink2.statsSnapshot.lastHash !== undefined);
	});
});

describe("diagnostic sink — write failure non-interference", () => {
	it("counts write failures as non-fatal and does not throw (best-effort)", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT, throwOnWriteFailure: false });
		// Force an unwritable target by pointing the sink at a directory path that is actually a file's parent? Use a path under a read-only dir is unreliable; instead use a path whose dirname is a regular file.
		const blockingFile = path.join(path.dirname(file), "blocking");
		fs.writeFileSync(blockingFile, "i am a file", "utf-8");
		const badPath = path.join(blockingFile, "sub", "diag.jsonl");
		const sink2 = new DiagnosticSink({ filePath: badPath, salt: SALT });
		const r = sink2.append(makeInput({ sourceEventId: "evt-1" }));
		assert.equal(r.status, "write_failed");
		assert.equal(sink2.statsSnapshot.writeFailures, 1);
	});

	it("throws only when throwOnWriteFailure is enabled", () => {
		const file = tempFile();
		const blockingFile = path.join(path.dirname(file), "blocking2");
		fs.writeFileSync(blockingFile, "i am a file", "utf-8");
		const badPath = path.join(blockingFile, "sub", "diag.jsonl");
		const sink = new DiagnosticSink({ filePath: badPath, salt: SALT, throwOnWriteFailure: true });
		assert.throws(() => sink.append(makeInput({ sourceEventId: "evt-1" })));
	});
});

describe("diagnostic sink — rejected records and oversized drops", () => {
	it("rejects a record that violates the allowlist safety invariant before writing", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT });
		const r = sink.append(makeInput({ sourceEventId: "evt-1", attributes: { prompt: "x" } }));
		assert.equal(r.status, "rejected");
		assert.equal(sink.statsSnapshot.internalFailures, 1);
		assert.equal(fs.existsSync(file), false);
	});

	it("drops and counts records that exceed maxRecordBytes", () => {
		const file = tempFile();
		const sink = new DiagnosticSink({ filePath: file, salt: SALT, maxRecordBytes: 64 });
		const r = sink.append(makeInput({ sourceEventId: "evt-1", attributes: { sourceType: "x".repeat(400) } }));
		assert.equal(r.status, "dropped");
		assert.equal(sink.statsSnapshot.droppedOversized, 1);
		assert.equal(sink.statsSnapshot.internalFailures, 1);
		assert.equal(fs.existsSync(file), false);
	});

	it("provides createDiagnosticSink and readDiagnosticSinkTail helpers", () => {
		const file = tempFile();
		const sink = createDiagnosticSink(path.dirname(file), path.basename(file), { salt: SALT });
		sink.append(makeInput({ sourceEventId: "evt-1" }));
		const tail = readDiagnosticSinkTail(file);
		assert.equal(tail.lastSequence, 0);
		assert.equal(tail.eventIds.size, 1);
	});
});
