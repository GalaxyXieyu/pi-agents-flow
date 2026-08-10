import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowStore } from "../store.ts";
import type { WorkflowEvent } from "../types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { reduceWorkflowEvents } from "../reducer.ts";
import { projectRunAudit } from "./audit.ts";

export interface RunAuditWriterOptions {
	/**
	 * Local installation salt for hashing identifiers in the audit. Never a
	 * secret and never exported; only used to make identifier fingerprints
	 * non-identical across installations.
	 */
	salt?: string;
}

export interface RunAuditWriteResult {
	ok: boolean;
	path?: string;
	error?: string;
}

function readWorkflowEvents(filePath: string): WorkflowEvent[] {
	const raw = fs.readFileSync(filePath, "utf-8");
	const events: WorkflowEvent[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line) as WorkflowEvent);
		} catch {
			// Best-effort: a corrupt trailing line must not fail the whole audit.
			continue;
		}
	}
	return events;
}

/**
 * Best-effort, non-authoritative run-audit sidecar writer.
 *
 * Reads the authoritative `events.jsonl`, projects a `RunAuditV1`, and writes
 * it to `delivery/run-audit.json` alongside the final deliverable. Diagnostic
 * events never enter `events.jsonl`; this writer only reads from it and writes
 * a separate, non-authoritative sidecar. It never throws into the caller: any
 * failure (missing event log, projection error, write error) is swallowed and
 * reported via the returned {@link RunAuditWriteResult} so the authoritative
 * workflow lifecycle is never interrupted.
 */
export function writeRunAuditSidecar(store: WorkflowStore, runId: string, options: RunAuditWriterOptions = {}): RunAuditWriteResult {
	try {
		const events = readWorkflowEvents(store.paths(runId).events);
		const run = reduceWorkflowEvents(events);
		const audit = projectRunAudit({
			run,
			events,
			diagnostics: [],
			salt: options.salt ?? "",
			droppedDiagnosticCount: 0,
		});
		const outPath = path.join(store.paths(runId).delivery, "run-audit.json");
		writeAtomicJson(outPath, audit);
		return { ok: true, path: outPath };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
