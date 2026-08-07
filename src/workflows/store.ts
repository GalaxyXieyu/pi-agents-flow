import * as fs from "node:fs";
import * as path from "node:path";

import { writeAtomicJson } from "../shared/atomic-json.ts";
import { createLocalWorkflowArtifactStore } from "./artifact-store.ts";
import { hydrateWorkflowResult } from "./output-ports.ts";
import { reduceWorkflowEvent, reduceWorkflowEvents } from "./reducer.ts";
import { resolveWorkflowMaxNodeAttempts } from "./retry-policy.ts";
import type { WorkflowPolicy } from "./policy.ts";
import type { WorkflowLanguage } from "./language.ts";
import type { WorkflowEvent, WorkflowMode, WorkflowRun } from "./types.ts";

export interface WorkflowStorePaths {
	dir: string;
	manifest: string;
	events: string;
	nodes: string;
	artifacts: string;
	bundles: string;
	delivery: string;
}

export interface CreateWorkflowStoreOptions {
	rootDir: string;
}

export interface CreateWorkflowInput {
	id: string;
	mode: WorkflowMode;
	goal: string;
	language?: WorkflowLanguage;
	cwd: string;
	sessionId: string;
	branch: string;
	at?: number;
	policy?: WorkflowPolicy;
	maxNodeAttempts?: number;
}

export interface WorkflowStore {
	create(input: CreateWorkflowInput): WorkflowRun;
	append(runId: string, event: WorkflowEvent): WorkflowRun;
	load(runId: string): WorkflowRun;
	paths(runId: string): WorkflowStorePaths;
}

function assertRunId(runId: string): void {
	if (!/^[a-zA-Z0-9._-]+$/.test(runId)) {
		throw new Error("Workflow run id must contain only letters, numbers, dots, underscores, and hyphens.");
	}
}

function workflowPaths(rootDir: string, runId: string): WorkflowStorePaths {
	assertRunId(runId);
	const dir = path.join(rootDir, runId);
	return {
		dir,
		manifest: path.join(dir, "manifest.json"),
		events: path.join(dir, "events.jsonl"),
		nodes: path.join(dir, "nodes"),
		artifacts: path.join(dir, "artifacts"),
		bundles: path.join(dir, "bundles"),
		delivery: path.join(dir, "delivery"),
	};
}

function appendEvent(filePath: string, event: WorkflowEvent): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
}

function readEvents(filePath: string): WorkflowEvent[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`Workflow event log does not exist: ${filePath}`);
		throw error;
	}
	const events: WorkflowEvent[] = [];
	for (const [index, line] of raw.split("\n").entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid workflow event JSON at line ${index + 1}: ${String(error)}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Invalid workflow event at line ${index + 1}: expected an object.`);
		}
		events.push(parsed as WorkflowEvent);
	}
	return events;
}

function hydrateRunResults(run: WorkflowRun, artifactsDir: string): WorkflowRun {
	const artifactStore = createLocalWorkflowArtifactStore(artifactsDir);
	let changed = false;
	const nodes = Object.fromEntries(Object.entries(run.nodes).map(([nodeId, node]) => {
		if (!node.resultArtifact) return [nodeId, node];
		const result = hydrateWorkflowResult(node.resultArtifact, artifactStore);
		const attempts = node.attempts.map((attempt) => attempt.resultArtifact
			? { ...attempt, result: hydrateWorkflowResult(attempt.resultArtifact, artifactStore) }
			: attempt);
		changed = true;
		return [nodeId, { ...node, result, attempts }];
	}));
	return changed ? { ...run, nodes } : run;
}

export function createWorkflowStore(options: CreateWorkflowStoreOptions): WorkflowStore {
	const rootDir = path.resolve(options.rootDir);
	return {
		paths(runId) {
			return workflowPaths(rootDir, runId);
		},
		create(input) {
			const paths = workflowPaths(rootDir, input.id);
			if (fs.existsSync(paths.events) || fs.existsSync(paths.manifest)) {
				throw new Error(`Workflow run '${input.id}' already exists.`);
			}
			const event: WorkflowEvent = {
				id: `${input.id}:started`,
				type: "workflow.started",
				at: input.at ?? Date.now(),
				runId: input.id,
				mode: input.mode,
				goal: input.goal,
				...(input.language ? { language: input.language } : {}),
				cwd: input.cwd,
				sessionId: input.sessionId,
				branch: input.branch,
				...(input.policy ? { policy: input.policy } : {}),
				...(input.codingContract ? { codingContract: input.codingContract } : {}),
				maxNodeAttempts: resolveWorkflowMaxNodeAttempts(input.maxNodeAttempts),
			};
			const run = reduceWorkflowEvent(undefined, event);
			appendEvent(paths.events, event);
			writeAtomicJson(paths.manifest, run);
			return run;
		},
		append(runId, event) {
			const paths = workflowPaths(rootDir, runId);
			const run = reduceWorkflowEvents(readEvents(paths.events));
			if (run.appliedEventIds.includes(event.id)) return hydrateRunResults(run, paths.artifacts);
			const next = reduceWorkflowEvent(run, event);
			appendEvent(paths.events, event);
			writeAtomicJson(paths.manifest, next);
			return hydrateRunResults(next, paths.artifacts);
		},
		load(runId) {
			const paths = workflowPaths(rootDir, runId);
			const rawRun = reduceWorkflowEvents(readEvents(paths.events));
			if (rawRun.id !== runId) throw new Error(`Workflow event log belongs to '${rawRun.id}', not '${runId}'.`);
			writeAtomicJson(paths.manifest, rawRun);
			return hydrateRunResults(rawRun, paths.artifacts);
		},
	};
}
