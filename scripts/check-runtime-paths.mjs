#!/usr/bin/env node
/**
 * check-runtime-paths.mjs
 *
 * Semantic runtime path checker for the Pi agents-flow runtime tree (`.pi/agents-flow`).
 *
 * Scope
 * -----
 * Audits *only* the known mutable path fields in structured runtime metadata and
 * reports whether any still reference the legacy runtime root `.pi-agents-flow`
 * (pre-`.pi` migration). It mirrors the path-rewrite semantics implemented in
 * `src/shared/project-runtime.ts` (LEGACY_PROJECT_RUNTIME_ROOT vs the preferred
 * `.pi/agents-flow` root) but is intentionally read-only: it never modifies files.
 *
 * Known path fields checked:
 *   - attempt-level metadata:   metadataPath, structuredOutputPath
 *   - artifact storage fields:  storage.materializedPath, storage.key
 *   - artifact path fields:     inputPath, outputPath, jsonlPath, transcriptPath
 *   - context-pack / runtime    outputSlots.* (path values), cwd, paths of runtime
 *     descriptors (bundle manifest.json) when they carry a path-shaped field
 *
 * Deliberately EXCLUDED (immutable / historical, not mutable runtime metadata):
 *   - artifacts/objects/**           content-addressed immutable blobs
 *   - historical report body text    agentSpec.instructions, objective, inlineValue,
 *                                    evidence.sources, output documents, transcripts
 *   - audit outputs and any plain    scanned only for *path-typed* fields; free-form
 *     Markdown / body content        body strings are never flagged
 *
 * The checker walks structured files (manifest.json, events.jsonl, *-meta.json,
 * bundle manifest.json) field-by-field and only inspects values sitting under a
 * path-typed key. Free-form prose is never searched.
 *
 * Result classification
 * ---------------------
 *   violation / "mutable"   : legacy path found in a known mutable path field.
 *                             These must be migrated (rewrite to `.pi/agents-flow`).
 *   violation / "unclassified": a path-typed value contains a legacy path fragment
 *                             but the surrounding shape is not one of the canonical
 *                             runtime descriptors. Reported as a warning for review.
 *   info / excluded         : occurrences found in historical body (instructions,
 *                             inlineValue, evidence) — intentionally not counted.
 *
 * Exit codes:
 *   0  no mutable legacy path references
 *   1  one or more mutable (or unclassified) legacy path references remain
 *
 * Usage:
 *   node scripts/check-runtime-paths.mjs [<runtimeDir>]
 *   # default <runtimeDir> = <cwd>/.pi/agents-flow
 *   # --verbose prints excluded (historical) occurrences for transparency
 */
import * as fs from "node:fs";
import * as path from "node:path";

const LEGACY_ROOT = ".pi-agents-flow";
const PREFERRED_ROOT = ".pi/agents-flow";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
const ARGS = process.argv.slice(2);
const verbose = ARGS.includes("--verbose");
const positional = ARGS.filter((a) => a !== "--verbose");

const runtimeRoot = (() => {
	if (positional.length > 0) return path.resolve(positional[0]);
	const cwd = process.cwd();
	return path.join(cwd, PREFERRED_ROOT);
})();

// ---------------------------------------------------------------------------
// Path-field recognition
// ---------------------------------------------------------------------------
/**
 * A "known path field" is a leaf key that carries a filesystem or URL path.
 * Only values under one of these keys are candidate mutable path references.
 * Everything else is historical/body content and never searched.
 */
const KNOWN_PATH_KEYS = new Set([
	// attempt metadata
	"metadataPath",
	"structuredOutputPath",
	// artifact storage
	"materializedPath",
	"key",
	// artifact path fields (ArtifactPaths shape)
	"inputPath",
	"outputPath",
	"jsonlPath",
	"transcriptPath",
	// runtime / context-pack descriptor paths
	"path",
	"file",
	"cwd",
]);

/** Parent container keys whose child values are filesystem paths (e.g. outputSlots.*). */
const KNOWN_PATH_CONTAINERS = new Set(["outputSlots"]);

// A legacy root reference appears in one of these forms:
//   bare relative           `.pi-agents-flow`
//   leading slash segment   `/.pi-agents-flow`
//   absolute path           `.../.pi-agents-flow/...`
//   file URL                `file://.pi-agents-flow/...` | `file:///.../.pi-agents-flow/...`
const LEGACY_ROOT_RE = /(?:^|\/|\\|:|")\.pi-agents-flow(?:\/|\\|"|$)/;

function containsLegacyRoot(value) {
	return LEGACY_ROOT_RE.test(value);
}

// ---------------------------------------------------------------------------
// Files to exclude from structural scanning
// ---------------------------------------------------------------------------
const CONTENT_ADDRESSED_DIR = "objects";

function isContentAddressed(relPath) {
	// matches `<root>/.../artifacts/objects/<aa>/<sha>` — content-addressed blobs
	return relPath.split(/[\\/]/).includes(CONTENT_ADDRESSED_DIR);
}

const STRUCTURED_EXTENSIONS = new Set([".json", ".jsonl"]);

/**
 * Structured runtime metadata files are the only files we open.
 * We deliberately never open `*_input.md` / `*_output.md` / `*_transcript.jsonl`
 * bodies for path scanning beyond their path-typed fields; transcripts are
 * content body and excluded. metadata sinks (`*-meta.json`) are checked.
 */
function isStructuredMetadataFile(relPath) {
	const ext = path.extname(relPath).toLowerCase();
	if (!STRUCTURED_EXTENSIONS.has(ext)) return false;
	// Only metadata sinks / descriptors, not transcript bodies.
	const base = path.basename(relPath);
	if (base.endsWith("_transcript.jsonl")) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Structural scan
// ---------------------------------------------------------------------------
/**
 * Walk a JSON value and inspect only values that sit under a known path key
 * (or under a known path container such as `outputSlots`).
 * `ancestorKeys` is the list of ancestor keys (leaf-most last) for shape-aware logic.
 */
function scanValue(node, ancestorKeys, fileRel, findings, excluded, fieldPath) {
	if (node === null || node === undefined) return;

	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) {
			scanValue(node[i], ancestorKeys, fileRel, findings, excluded, `${fieldPath}[${i}]`);
		}
		return;
	}

	if (typeof node === "object") {
		for (const [key, child] of Object.entries(node)) {
			scanValue(child, [...ancestorKeys, key], fileRel, findings, excluded, fieldPath ? `${fieldPath}.${key}` : key);
		}
		return;
	}

	if (typeof node !== "string") return;
	if (!containsLegacyRoot(node)) return;

	const parentKey = ancestorKeys[ancestorKeys.length - 1];
	const grandparentKey = ancestorKeys.length >= 2 ? ancestorKeys[ancestorKeys.length - 2] : undefined;

	// A value is a candidate mutable path reference when it sits directly under a
	// known path key, or under a known path container (outputSlots.*).
	const isPathField =
		KNOWN_PATH_KEYS.has(parentKey) ||
		(grandparentKey !== undefined && KNOWN_PATH_CONTAINERS.has(grandparentKey));

	if (!isPathField) {
		// Value sits in a free-form/body position — historical or body content,
		// intentionally excluded from mutable-path accounting.
		if (verbose) excluded.push({ file: fileRel, field: fieldPath, value: truncate(node) });
		return;
	}

	const classification = classifyPathField(ancestorKeys, fileRel);
	if (classification === "excluded") {
		if (verbose) excluded.push({ file: fileRel, field: fieldPath, value: truncate(node) });
	} else {
		findings.push({ classification, file: fileRel, field: fieldPath, value: node });
	}
}

/**
 * Decide whether a path-typed value carrying the legacy root is a true mutable
 * reference (must migrate), an unclassified shape (warn), or intentionally
 * excluded historical body.
 */
function classifyPathField(ancestorKeys, fileRel) {
	const parentKey = ancestorKeys[ancestorKeys.length - 1];
	const grandparentKey = ancestorKeys.length >= 2 ? ancestorKeys[ancestorKeys.length - 2] : undefined;

	// `storage.key` holds relative `objects/...` keys, not runtime roots — a
	// legacy root here would be malformed and worth surfacing as unclassified.
	if (parentKey === "key") return "unclassified";

	// Values under an `outputSlots` container are filesystem paths.
	if (grandparentKey !== undefined && KNOWN_PATH_CONTAINERS.has(grandparentKey)) return "mutable";

	// Canonical mutable path fields.
	if (KNOWN_PATH_KEYS.has(parentKey)) return "mutable";

	return "unclassified";
}

function truncate(value) {
	return value.length > 160 ? `${value.slice(0, 160)}…` : value;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function collectFiles(dir) {
	const out = [];
	const visit = (entryAbs) => {
		const stat = fs.lstatSync(entryAbs);
		if (stat.isSymbolicLink()) return;
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(entryAbs)) visit(path.join(entryAbs, entry));
			return;
		}
		if (!stat.isFile()) return;
		const rel = path.relative(dir, entryAbs);
		// Content-addressed immutable blobs are never scanned.
		if (isContentAddressed(rel)) return;
		out.push({ abs: entryAbs, rel });
	};
	visit(dir);
	return out;
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------
function scanFile(file, runtimeRoot) {
	const rel = file.rel;
	const findings = [];
	const excluded = [];

	// Only structured runtime metadata files are opened.
	if (!isStructuredMetadataFile(rel)) {
		// Plain Markdown bodies / transcripts are excluded by design.
		return { findings, excluded, skipped: true, reason: "non-structured body" };
	}

	let raw;
	try {
		raw = fs.readFileSync(file.abs, "utf8");
	} catch (error) {
		return { findings, excluded, skipped: true, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (rel.endsWith(".jsonl")) {
		let lineNo = 0;
		for (const line of raw.split(/\r?\n/)) {
			lineNo++;
			if (!line.trim()) continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // skip malformed lines; not a path field
			}
			scanValue(parsed, [], rel, findings, excluded, `${rel}:${lineNo}`);
		}
	} else {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { findings, excluded, skipped: true, reason: "unparseable json" };
		}
		scanValue(parsed, [], rel, findings, excluded, rel);
	}

	return { findings, excluded, skipped: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
	if (!fs.existsSync(runtimeRoot) || !fs.statSync(runtimeRoot).isDirectory()) {
		process.stdout.write(`[check-runtime-paths] runtime root not found (nothing to check): ${runtimeRoot}\n`);
		process.exitCode = 0;
		return;
	}

	const files = collectFiles(runtimeRoot);
	const violations = []; // classification === "mutable"
	const unclassified = []; // classification === "unclassified"
	const excluded = []; // historical / excluded occurrences
	let scannedStructured = 0;
	let skippedFiles = 0;

	for (const file of files) {
		const result = scanFile(file, runtimeRoot);
		if (result.skipped) {
			skippedFiles++;
			continue;
		}
		scannedStructured++;
		for (const f of result.findings) {
			if (f.classification === "mutable") violations.push(f);
			else unclassified.push(f);
		}
		for (const e of result.excluded) excluded.push(e);
	}

	process.stdout.write(`[check-runtime-paths] runtime root: ${runtimeRoot}\n`);
	process.stdout.write(`[check-runtime-paths] files scanned (structured metadata): ${scannedStructured}; skipped (bodies/transcripts/objects): ${skippedFiles}\n`);

	if (violations.length > 0) {
		process.stdout.write(`[check-runtime-paths] MUTABLE legacy path references (must migrate): ${violations.length}\n`);
		for (const v of violations) {
			process.stdout.write(`  - [mutable] ${v.file} :: ${v.field}\n      = ${truncate(v.value)}\n`);
		}
	} else {
		process.stdout.write("[check-runtime-paths] 0 mutable legacy path references.\n");
	}

	if (unclassified.length > 0) {
		process.stdout.write(`[check-runtime-paths] UNCLASSIFIED path-typed references (review): ${unclassified.length}\n`);
		for (const v of unclassified) {
			process.stdout.write(`  - [unclassified] ${v.file} :: ${v.field}\n      = ${truncate(v.value)}\n`);
		}
	}

	if (verbose && excluded.length > 0) {
		process.stdout.write(`[check-runtime-paths] excluded historical occurrences (informational): ${excluded.length}\n`);
		for (const e of excluded) {
			process.stdout.write(`  - [excluded] ${e.file} :: ${e.field} = ${truncate(e.value)}\n`);
		}
	}

	const totalProblems = violations.length + unclassified.length;
	if (totalProblems > 0) {
		process.exitCode = 1;
	}
}

main();
