import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";
export const STRUCTURED_OUTPUT_SUBMISSION_DIR_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SUBMISSION_DIR";
export const MISSING_STRUCTURED_OUTPUT_CALL_ERROR = "Missing structured_output call; this step has outputSchema and must finish by calling structured_output.";
export const MAX_STRUCTURED_OUTPUT_FILE_BYTES = 16 * 1024 * 1024;

export interface StructuredOutputRuntime {
	schema: JsonSchemaObject;
	schemaPath: string;
	outputPath: string;
	submissionDir?: string;
}

export interface StructuredOutputSubmission {
	value?: unknown;
	path?: string;
	sha256?: string;
}

export interface StructuredOutputCaptureDetails {
	path: string;
	source: "inline" | "file";
	sourcePath?: string;
	bytes: number;
	sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Repair two common provider mistakes before the strict result validator runs:
 * 1. submitting an object-schema result directly instead of under tool-level `value`;
 * 2. JSON-encoding the result inside `value`.
 *
 * Canonical callers remain unchanged. File transport and ambiguous envelope-shaped
 * inputs are never guessed.
 */
export function normalizeStructuredOutputSubmission(params: unknown): StructuredOutputSubmission {
	if (!isRecord(params)) return { value: params };
	const hasEnvelopeKey = ["value", "path", "sha256"].some((key) => Object.prototype.hasOwnProperty.call(params, key));
	if (!hasEnvelopeKey) return { value: params };
	const submission = { ...params } as StructuredOutputSubmission;
	if (typeof submission.value !== "string") return submission;
	const encoded = submission.value.trim();
	if (!encoded.startsWith("{") && !encoded.startsWith("[")) return submission;
	try {
		submission.value = JSON.parse(encoded) as unknown;
	} catch (error) {
		throw new Error([
			"Structured output `value` looks like JSON text but is not valid JSON.",
			"Pass the parsed JSON object directly, not a quoted/JSON-encoded string.",
			`Parse error: ${error instanceof Error ? error.message : String(error)}`,
		].join(" "));
	}
	return submission;
}

const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_SINGLE_KEYWORDS = ["additionalItems", "additionalProperties", "contains", "not", "propertyNames", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "contentSchema"] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function rewriteLocalJsonPointerRefs(schema: unknown, pointerPrefix: string, inheritsWrapperResource = true): unknown {
	if (typeof schema === "boolean" || !schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const source = schema as Record<string, unknown>;
	const rewritten: Record<string, unknown> = { ...source };
	const sharesWrapperResource = inheritsWrapperResource && typeof source.$id !== "string";
	if (sharesWrapperResource) {
		for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
			const ref = source[keyword];
			if (ref === "#") rewritten[keyword] = pointerPrefix;
			else if (typeof ref === "string" && ref.startsWith("#/")) rewritten[keyword] = `${pointerPrefix}${ref.slice(1)}`;
		}
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const entries = source[keyword];
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
		rewritten[keyword] = Object.fromEntries(Object.entries(entries).map(([name, nested]) => [
			name,
			rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	const items = source.items;
	if (Array.isArray(items)) rewritten.items = items.map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	else if (items !== undefined) rewritten.items = rewriteLocalJsonPointerRefs(items, pointerPrefix, sharesWrapperResource);
	for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
		if (source[keyword] !== undefined) rewritten[keyword] = rewriteLocalJsonPointerRefs(source[keyword], pointerPrefix, sharesWrapperResource);
	}
	for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
		if (Array.isArray(source[keyword])) rewritten[keyword] = source[keyword].map((nested) => rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource));
	}
	const dependencies = source.dependencies;
	if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
		rewritten.dependencies = Object.fromEntries(Object.entries(dependencies).map(([name, nested]) => [
			name,
			Array.isArray(nested) ? nested : rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		]));
	}
	return rewritten;
}

export function createStructuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
	const inlineSchema = rewriteLocalJsonPointerRefs(schema, "#/anyOf/0/properties/value/anyOf/0") as JsonSchemaObject;
	const directSchema = rewriteLocalJsonPointerRefs(schema, "#/anyOf/1") as JsonSchemaObject;
	return {
		type: "object",
		description: "Preferred shape: {value: <complete result>}. Compatibility also accepts a direct object result and JSON text in value; the runtime normalizes both before strict validation.",
		anyOf: [
			{
				type: "object",
				properties: {
					value: {
						description: "Complete inline result. Pass the JSON value directly, not encoded text.",
						anyOf: [inlineSchema, { type: "string" }],
					},
					path: {
						type: "string",
						minLength: 1,
						description: "Path to a JSON file containing the complete result. The file must already exist inside this run's submission directory.",
					},
					sha256: {
						type: "string",
						pattern: "^[A-Fa-f0-9]{64}$",
						description: "Optional SHA-256 digest of the referenced JSON file. Omit it unless computed from the actual file.",
					},
				},
				oneOf: [
					{ required: ["value"], not: { anyOf: [{ required: ["path"] }, { required: ["sha256"] }] } },
					{ required: ["path"], not: { required: ["value"] } },
				],
				additionalProperties: false,
			},
			directSchema,
		],
	};
}

interface CompiledJsonSchema {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

type CompileJsonSchema = (schema: unknown) => CompiledJsonSchema;

let cachedCompile: Promise<CompileJsonSchema> | undefined;

export async function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
	const requireFromRoot = createRequire(path.join(packageRoot, "package.json"));
	const resolved = requireFromRoot.resolve("typebox/compile");
	const mod = (await import(pathToFileURL(resolved).href)) as { Compile?: unknown };
	return typeof mod.Compile === "function" ? (mod.Compile as CompileJsonSchema) : undefined;
}

async function importCompile(): Promise<CompileJsonSchema> {
	const failures: string[] = [];
	try {
		const mod = (await import("typebox/compile")) as { Compile?: unknown };
		if (typeof mod.Compile === "function") return mod.Compile as CompileJsonSchema;
		failures.push("typebox/compile did not export a Compile function");
	} catch (error) {
		failures.push(`direct import failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (packageRoot) {
		try {
			const compile = await resolveCompileFromPackageRoot(packageRoot);
			if (compile) return compile;
			failures.push("Pi package root typebox/compile did not export a Compile function");
		} catch (error) {
			failures.push(`Pi package root import failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		failures.push(`${PI_CODING_AGENT_PACKAGE_ROOT_ENV} is not set`);
	}
	throw new Error(`Cannot load typebox/compile for structured output validation (${failures.join("; ")})`);
}

function loadCompile(): Promise<CompileJsonSchema> {
	if (!cachedCompile) {
		cachedCompile = importCompile().catch((error) => {
			cachedCompile = undefined;
			throw error;
		});
	}
	return cachedCompile;
}

export function assertJsonSchemaObject(schema: unknown, label = "outputSchema"): asserts schema is JsonSchemaObject {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export function createStructuredOutputRuntime(schema: JsonSchemaObject, baseDir?: string): StructuredOutputRuntime {
	assertJsonSchemaObject(schema);
	const rootDir = baseDir ?? os.tmpdir();
	fs.mkdirSync(rootDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(rootDir, "pi-subagent-structured-"));
	const schemaPath = path.join(dir, "schema.json");
	const outputPath = path.join(dir, "output.json");
	const submissionDir = path.join(dir, "submissions");
	fs.mkdirSync(submissionDir, { mode: 0o700 });
	fs.writeFileSync(schemaPath, JSON.stringify(schema), { mode: 0o600 });
	return { schema, schemaPath, outputPath, submissionDir };
}

function structuralValidationHints(schema: unknown, value: unknown, valuePath = "root", hints: string[] = []): string[] {
	if (hints.length >= 4 || !isRecord(schema)) return hints;
	if (isRecord(value) && isRecord(schema.properties)) {
		const properties = schema.properties;
		if (schema.additionalProperties === false) {
			const unexpected = Object.keys(value).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
			if (unexpected.length > 0) {
				hints.push(`${valuePath}: unexpected field${unexpected.length === 1 ? "" : "s"} ${unexpected.map((key) => `'${key}'`).join(", ")}; allowed fields: ${Object.keys(properties).join(", ") || "none"}`);
			}
		}
		if (Array.isArray(schema.required)) {
			const missing = schema.required.filter((key): key is string => typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key));
			if (missing.length > 0) hints.push(`${valuePath}: missing required field${missing.length === 1 ? "" : "s"} ${missing.map((key) => `'${key}'`).join(", ")}`);
		}
		for (const [key, nestedSchema] of Object.entries(properties)) {
			if (hints.length >= 4) break;
			if (Object.prototype.hasOwnProperty.call(value, key)) structuralValidationHints(nestedSchema, value[key], valuePath === "root" ? key : `${valuePath}.${key}`, hints);
		}
	}
	if (Array.isArray(value) && isRecord(schema.items)) {
		for (let index = 0; index < value.length && hints.length < 4; index++) structuralValidationHints(schema.items, value[index], `${valuePath}.${index}`, hints);
	}
	return hints;
}

export async function validateStructuredOutputValue(schema: JsonSchemaObject, value: unknown): Promise<{ status: "valid" } | { status: "invalid"; message: string }> {
	const compile = await loadCompile();
	let validator: CompiledJsonSchema;
	try {
		validator = compile(schema);
	} catch (error) {
		return { status: "invalid", message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (validator.Check(value)) return { status: "valid" };
	const hints = structuralValidationHints(schema, value);
	const errors = [...validator.Errors(value)]
		.slice(0, 8)
		.map((error) => {
			const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
			return `${pathText}: ${error.message}`;
		});
	return { status: "invalid", message: [...hints, ...errors].join("; ") || "schema validation failed" };
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, filePath);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function atomicWriteFile(filePath: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempPath, content, { mode: 0o600, flag: "wx" });
		fs.renameSync(tempPath, filePath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function sha256(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function captureStructuredOutputSubmission(
	runtime: StructuredOutputRuntime,
	submission: StructuredOutputSubmission,
): Promise<StructuredOutputCaptureDetails> {
	const hasValue = Object.prototype.hasOwnProperty.call(submission, "value") && submission.value !== undefined;
	const hasPath = Object.prototype.hasOwnProperty.call(submission, "path") && submission.path !== undefined;
	if (hasValue && hasPath) throw new Error("Structured output transport error: provide exactly one of `value` (the complete inline result) or `path` (a file containing the complete result), not both. Do not send `value: null` with `path`.");
	if (!hasValue && !hasPath) throw new Error("Structured output transport error: provide exactly one top-level transport field: `value` for the complete inline result, or `path` for a complete-result JSON file.");
	if (!hasPath && submission.sha256 !== undefined) throw new Error("Structured output transport error: `sha256` is only valid with `path`; omit it for inline `value` submissions.");

	let value: unknown;
	let content: string | Buffer;
	let sourcePath: string | undefined;
	if (hasPath) {
		if (typeof submission.path !== "string" || !submission.path.trim()) throw new Error("Structured output `path` must be a non-empty string.");
		const requestedPath = path.resolve(process.cwd(), submission.path);
		const submissionRoot = fs.realpathSync(runtime.submissionDir ?? path.join(path.dirname(runtime.outputPath), "submissions"));
		try {
			sourcePath = fs.realpathSync(requestedPath);
		} catch (error) {
			throw new Error(`Structured output file not found at '${requestedPath}'. First write one JSON file containing the complete result inside '${submissionRoot}', then submit that existing file's path. Do not submit an output-slot path or a guessed staging path. Cause: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isWithinRoot(sourcePath, submissionRoot)) throw new Error(`Structured output file '${sourcePath}' is outside this run's submission directory '${submissionRoot}'. Tool-level path must reference a complete-result JSON file inside that directory, not a workflow output-slot file.`);
		let descriptor: number | undefined;
		try {
			descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
			const stat = fs.fstatSync(descriptor);
			if (!stat.isFile()) throw new Error("Structured output `path` must reference a regular file.");
			if (stat.size > MAX_STRUCTURED_OUTPUT_FILE_BYTES) throw new Error(`Structured output file exceeds the ${MAX_STRUCTURED_OUTPUT_FILE_BYTES}-byte limit.`);
			content = fs.readFileSync(descriptor);
		} finally {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		}
		if (content.byteLength > MAX_STRUCTURED_OUTPUT_FILE_BYTES) throw new Error(`Structured output file exceeds the ${MAX_STRUCTURED_OUTPUT_FILE_BYTES}-byte limit.`);
		const digest = sha256(content);
		if (submission.sha256 && digest !== submission.sha256.toLowerCase()) throw new Error(`Structured output SHA-256 mismatch: expected ${submission.sha256.toLowerCase()}, received ${digest}.`);
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
		} catch (error) {
			throw new Error(`Failed to parse structured output file: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		value = submission.value;
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("Structured output `value` must be JSON-serializable.");
		content = encoded;
	}

	const validation = await validateStructuredOutputValue(runtime.schema, value);
	if (validation.status === "invalid") {
		// T2 hardening: when a text/document string is submitted as the inline
		// `value` but the outputSchema expects a JSON object, surface an explicit
		// corrective hint instead of a bare "root: must be object". Models (esp.
		// weaker ones) frequently dump markdown/report prose as the value and need
		// to be told it must be the JSON object described by outputSchema, not prose.
		const expectsString = runtime.schema.type === "string" || (Array.isArray(runtime.schema.type) && runtime.schema.type.includes("string"));
		const proseHint =
			!expectsString && typeof value === "string" && !value.trim().startsWith("{") && !value.trim().startsWith("[")
				? " The submitted `value` is a string that does not look like JSON — it appears to be document/prose text. structured_output expects the complete result as the JSON object described by outputSchema (e.g. {summary:{...}, diagnostics:{...}}), never a markdown report or narrative. Provide the structured JSON object directly in `value`."
				: "";
		throw new Error(`Structured output validation failed: ${validation.message}${proseHint}`);
	}
	const canonicalContent = JSON.stringify(value);
	if (canonicalContent === undefined) throw new Error("Structured output must be JSON-serializable.");
	atomicWriteFile(runtime.outputPath, canonicalContent);
	return {
		path: runtime.outputPath,
		source: hasPath ? "file" : "inline",
		...(sourcePath ? { sourcePath } : {}),
		bytes: Buffer.byteLength(canonicalContent),
		sha256: sha256(canonicalContent),
	};
}

export async function readStructuredOutput(runtime: StructuredOutputRuntime): Promise<{ value?: unknown; error?: string }> {
	if (!fs.existsSync(runtime.outputPath)) {
		return { error: MISSING_STRUCTURED_OUTPUT_CALL_ERROR };
	}
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(runtime.outputPath, "utf-8"));
	} catch (error) {
		return { error: `Failed to read structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const validation = await validateStructuredOutputValue(runtime.schema, value);
		if (validation.status === "invalid") return { error: `Structured output validation failed: ${validation.message}` };
	} catch (error) {
		return { error: `Failed to validate structured output: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { value };
}

export function cleanupStructuredOutputRuntime(runtime: StructuredOutputRuntime | undefined): void {
	if (!runtime) return;
	try {
		fs.rmSync(path.dirname(runtime.schemaPath), { recursive: true, force: true });
	} catch {
		// Best-effort temp cleanup.
	}
}
