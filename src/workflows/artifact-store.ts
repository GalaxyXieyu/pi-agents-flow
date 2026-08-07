import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { WorkflowArtifactClassification, WorkflowArtifactDescriptor } from "./types.ts";

export interface WorkflowArtifactStore {
	allocateOutputSlot(input: { workflowId: string; nodeId: string; attemptId: string; port: string }): string;
	captureOutputSlot(input: {
		workflowId: string;
		nodeId: string;
		attemptId: string;
		port: string;
		mediaType: string;
		classification?: WorkflowArtifactClassification;
		slotPath: string;
		expectedSha256?: string;
		maxBytes: number;
		/** Additional trusted directories accepted when the file is not at its preallocated slot. */
		fallbackDirs?: string[];
	}): WorkflowArtifactDescriptor;
	put(input: {
		workflowId: string;
		nodeId: string;
		attemptId: string;
		port: string;
		mediaType: string;
		classification?: WorkflowArtifactClassification;
		content: string | Buffer;
	}): WorkflowArtifactDescriptor;
	read(descriptor: WorkflowArtifactDescriptor): Buffer;
	verify(descriptor: WorkflowArtifactDescriptor): void;
}

function safeSegment(value: string, field: string): string {
	if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`${field} must contain only letters, numbers, dots, underscores, and hyphens.`);
	return value;
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, filePath);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function descriptorDigest(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Text-bearing media types are stored as UTF-8 so completion and quality readers can treat the
 * artifact as text. File submissions written to an output slot arrive as raw bytes; without this
 * classification every slot-captured document would be tagged `binary` and rejected by the
 * deep-research completion gate, which requires UTF-8 deliverables.
 */
function isTextMediaType(mediaType: string): boolean {
	const normalized = mediaType.trim().toLowerCase();
	return normalized.startsWith("text/") || normalized === "application/json" || normalized.endsWith("+json") || normalized.endsWith("+xml");
}

export function createLocalWorkflowArtifactStore(rootDir: string): WorkflowArtifactStore {
	const root = path.resolve(rootDir);
	return {
		allocateOutputSlot(input) {
			const workflowId = safeSegment(input.workflowId, "workflowId");
			const nodeId = safeSegment(input.nodeId, "nodeId");
			const attemptId = safeSegment(input.attemptId.replace(/:/g, "_"), "attemptId");
			const port = safeSegment(input.port, "port");
			const slotPath = path.join(root, "staging", workflowId, nodeId, attemptId, port);
			fs.mkdirSync(path.dirname(slotPath), { recursive: true, mode: 0o700 });
			fs.rmSync(slotPath, { force: true });
			return slotPath;
		},
		captureOutputSlot(input) {
			const workflowId = safeSegment(input.workflowId, "workflowId");
			const nodeId = safeSegment(input.nodeId, "nodeId");
			const attemptId = safeSegment(input.attemptId.replace(/:/g, "_"), "attemptId");
			const port = safeSegment(input.port, "port");
			const expected = path.join(root, "staging", workflowId, nodeId, attemptId, port);
			const actual = path.resolve(input.slotPath);
			if (actual !== expected) {
				// Children launched before slot paths were communicated (or instructed by an
				// older guide) write into their harness-managed submission directory. Accept
				// those trusted directories; reject everything else with the slot named.
				const trusted = (input.fallbackDirs ?? []).map((dir) => path.resolve(dir));
				if (!trusted.some((dir) => isWithinRoot(actual, dir))) {
					throw new Error(`Output port '${input.port}' file must use its preallocated output slot '${expected}'.`);
				}
			}
			let descriptor: number | undefined;
			let content: Buffer;
			try {
				descriptor = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
				const stat = fs.fstatSync(descriptor);
				if (!stat.isFile()) throw new Error(`Output port '${input.port}' must be a regular file.`);
				if (stat.size > input.maxBytes) throw new Error(`Output port '${input.port}' exceeds its ${input.maxBytes}-byte file budget.`);
				content = fs.readFileSync(descriptor);
			} catch (error) {
				throw new Error(`Failed to capture output port '${input.port}': ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				if (descriptor !== undefined) fs.closeSync(descriptor);
			}
			const digest = descriptorDigest(content);
			if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== digest) throw new Error(`Output port '${input.port}' SHA-256 mismatch.`);
			return this.put({ ...input, content: isTextMediaType(input.mediaType) ? content.toString("utf8") : content });
		},
		put(input) {
			const workflowId = safeSegment(input.workflowId, "workflowId");
			const nodeId = safeSegment(input.nodeId, "nodeId");
			const port = safeSegment(input.port, "port");
			const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
			const sha256 = descriptorDigest(content);
			const key = path.join("objects", sha256.slice(0, 2), sha256);
			const objectPath = path.join(root, key);
			if (!fs.existsSync(objectPath)) {
				fs.mkdirSync(path.dirname(objectPath), { recursive: true });
				const tempPath = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
				try {
					fs.writeFileSync(tempPath, content, { mode: 0o600 });
					fs.renameSync(tempPath, objectPath);
				} finally {
					fs.rmSync(tempPath, { force: true });
				}
			}
			const descriptor: WorkflowArtifactDescriptor = {
				version: 1,
				artifactId: `artifact://${workflowId}/${nodeId}/${encodeURIComponent(input.attemptId)}/${port}/${sha256}`,
				sha256,
				mediaType: input.mediaType,
				bytes: content.byteLength,
				encoding: typeof input.content === "string" ? "utf-8" : "binary",
				classification: input.classification ?? "internal",
				storage: { backend: "local", key, materializedPath: objectPath },
				createdBy: { nodeId, attemptId: input.attemptId, port },
			};
			this.verify(descriptor);
			return descriptor;
		},
		read(descriptor) {
			this.verify(descriptor);
			return fs.readFileSync(descriptor.storage.materializedPath);
		},
		verify(descriptor) {
			if (descriptor.storage.backend !== "local") throw new Error(`Unsupported artifact backend '${descriptor.storage.backend}'.`);
			const objectPath = path.resolve(descriptor.storage.materializedPath);
			const relative = path.relative(root, objectPath);
			if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Artifact '${descriptor.artifactId}' escapes the workflow artifact store.`);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(objectPath);
			} catch {
				throw new Error(`Artifact '${descriptor.artifactId}' is missing.`);
			}
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact '${descriptor.artifactId}' is not a regular file.`);
			const content = fs.readFileSync(objectPath);
			if (content.byteLength !== descriptor.bytes || descriptorDigest(content) !== descriptor.sha256) {
				throw new Error(`Artifact '${descriptor.artifactId}' failed integrity verification.`);
			}
		},
	};
}

export function writeAtomicTextFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		fs.writeFileSync(tempPath, content, "utf-8");
		fs.renameSync(tempPath, filePath);
	} finally {
		fs.rmSync(tempPath, { force: true });
	}
}
