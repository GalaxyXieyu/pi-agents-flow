/**
 * Lightweight timing probes for the expensive pure stages of a workflow run.
 *
 * These are meant for CI regression watching (see the companion
 * `check-benchmark-regression` script): each function measures one isolated
 * stage end-to-end and returns its wall-clock duration in milliseconds. They
 * are intentionally defensive — given an incomplete run they fall back to a
 * zero-cost measurement instead of throwing — so a broken workflow directory
 * never takes down the whole benchmark.
 *
 * Usage:
 *   node --experimental-strip-types scripts/benchmark-timings.ts [--json <path>] [--human] [cwd] [workflow-run-dir]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgentsAll } from "../src/agents/agents.ts";
import { createLocalWorkflowArtifactStore } from "../src/workflows/artifact-store.ts";
import { materializeWorkflowContextPack } from "../src/workflows/context-pack.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "../src/workflows/retry-policy.ts";
import { reduceWorkflowEvents } from "../src/workflows/reducer.ts";
import { projectRunAudit } from "../src/workflows/diagnostics/audit.ts";
import { projectLifecycleDiagnostics } from "../src/workflows/diagnostics/projector.ts";
import type { WorkflowDataContract, WorkflowEvent, WorkflowNode, WorkflowResolvedOutput, WorkflowRun } from "../src/workflows/types.ts";
import { timed } from "./workflow-benchmark.ts";

export interface TimingProbe {
	label: string;
	ms: number | null;
}

export interface TimingBaseline {
	generatedAt: string;
	cwd: string;
	workflowRunDir?: string;
	timings: {
		discovery: number | null;
		"context-pack": number | null;
		"scheduler-queue": number | null;
		"diagnostics-projection": number | null;
	};
	probes: TimingProbe[];
}

/**
 * Measure the cost of discovering all subagents visible from `cwd`.
 *
 * Runs the full discovery pipeline (builtin + user + project + package agent
 * and chain discovery) and reports the wall-clock time. Returns `null` when
 * discovery is unavailable so the caller can skip recording.
 */
export async function measureDiscovery(cwd: string): Promise<TimingProbe> {
	try {
		const timedResult = await timed("discovery", async () => {
			discoverAgentsAll(cwd);
		});
		return { label: "discovery", ms: timedResult.ms };
	} catch {
		return { label: "discovery", ms: null };
	}
}

function inlineText(value: string): WorkflowResolvedOutput {
	return {
		kind: "inline",
		mediaType: "text/plain",
		bytes: Buffer.byteLength(value),
		classification: "internal",
		value,
	};
}

function syntheticNode(partial: Partial<WorkflowNode> & Pick<WorkflowNode, "id" | "status">): WorkflowNode {
	return {
		taskId: "task",
		kind: "custom",
		label: partial.id,
		order: 0,
		dependsOn: [],
		attempts: [],
		agentSpec: {
			id: `${partial.id}-agent`,
			baseAgent: "worker",
			role: partial.id,
			objective: partial.id,
			instructions: partial.id,
			context: "fresh",
		},
		...partial,
	};
}

/** Minimal accepted producer + ready consumer for context-pack / scheduler probes. */
export function createSyntheticTimingRun(cwd: string): WorkflowRun {
	const producer = syntheticNode({
		id: "producer",
		status: "accepted",
		outputs: { summary: inlineText("benchmark timing producer summary") },
	});
	const consumerContract: WorkflowDataContract = {
		version: 1,
		inputs: [{
			name: "summaries",
			purpose: "timing probe",
			from: [{ nodeId: "producer", port: "summary" }],
			delivery: "inline",
			merge: "first",
			required: true,
		}],
	};
	const consumer = syntheticNode({
		id: "consumer",
		status: "ready",
		dependsOn: ["producer"],
		dataContract: consumerContract,
	});
	const pending = syntheticNode({
		id: "pending",
		status: "pending",
		dependsOn: ["consumer"],
	});
	return {
		version: 1,
		id: "timing-probe",
		mode: "general",
		goal: "benchmark timing probes",
		cwd,
		sessionId: "timing-session",
		branch: "main",
		status: "active",
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		tasks: { task: { id: "task", label: "Timing", order: 0 } },
		nodes: {
			producer,
			consumer,
			pending,
		},
		decisions: [],
		appliedEventIds: [],
	};
}

function loadWorkflowRun(runDir: string): WorkflowRun | undefined {
	const manifestPath = path.join(runDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkflowRun;
	} catch {
		return undefined;
	}
}

function pickContextPackNode(run: WorkflowRun): WorkflowNode | undefined {
	const nodes = Object.values(run.nodes);
	return nodes.find((node) => node.dataContract && (node.status === "ready" || node.status === "pending" || node.status === "running"))
		?? nodes.find((node) => node.dataContract);
}

/**
 * Measure the cost of materializing the context pack for a single workflow node.
 *
 * Uses the node's own data contract and a throwaway temp output directory, so
 * it never touches the real workflow bundle tree. Returns `null` when the node
 * has no usable data contract.
 */
export async function measureContextPack(run: WorkflowRun, node: WorkflowNode): Promise<TimingProbe> {
	if (!node.dataContract) return { label: "context-pack", ms: null };
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-context-pack-"));
	try {
		const timedResult = await timed("context-pack", async () => {
			materializeWorkflowContextPack({
				run,
				node,
				contract: node.dataContract,
				outputDir: tmp,
				artifactStore: createLocalWorkflowArtifactStore(path.join(tmp, "artifacts")),
				taskContext: "benchmark-timings probe",
			});
		});
		return { label: "context-pack", ms: timedResult.ms };
	} catch {
		return { label: "context-pack", ms: null };
	} finally {
		try {
			fs.rmSync(tmp, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

/**
 * Compute the set of ready (runnable) node ids for a workflow run.
 *
 * Mirrors the scheduler's ready-queue gate so the CI script can watch how the
 * gate itself performs without spinning up a full scheduler.
 */
export function computeReadyQueue(run: WorkflowRun, retryNodeIds: ReadonlySet<string> = new Set()): string[] {
	const maxNodeAttempts = resolveWorkflowMaxNodeAttempts(run.maxNodeAttempts);
	return Object.values(run.nodes)
		.filter((node) => {
			if (node.status === "ready") return true;
			const lastFailure = node.attempts.at(-1)?.failure;
			return (
				retryNodeIds.has(node.id)
				&& (node.status === "failed" || node.status === "cancelled")
				&& lastFailure?.retryable !== false
				&& !workflowNodeAttemptsExhausted(node, maxNodeAttempts)
			);
		})
		.map((node) => node.id);
}

/**
 * Measure the cost of computing the ready queue for a workflow run.
 */
export async function measureSchedulerQueue(run: WorkflowRun): Promise<TimingProbe> {
	try {
		const timedResult = await timed("scheduler-queue", async () => {
			computeReadyQueue(run);
		});
		return { label: "scheduler-queue", ms: timedResult.ms };
	} catch {
		return { label: "scheduler-queue", ms: null };
	}
}

/**
 * Measure the cost of the structured diagnostics projections (run-audit +
 * lifecycle) over a real workflow event log. Defensive like the other probes:
 * a missing or unreadable event log yields `ms: null` instead of throwing, so a
 * broken workflow directory never takes down the benchmark. Requires a
 * `workflowRunDir`; without one it reports `null`.
 */
export async function measureDiagnosticsProjection(runDir?: string): Promise<TimingProbe> {
	const probe: TimingProbe = { label: "diagnostics-projection", ms: null };
	if (!runDir) return probe;
	const eventsPath = path.join(runDir, "events.jsonl");
	let events: WorkflowEvent[];
	try {
		events = fs.readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return probe;
	}
	if (events.length === 0) return probe;
	try {
		const workflowId = path.basename(runDir);
		const timedResult = await timed("diagnostics-projection", async () => {
			const run = reduceWorkflowEvents(events);
			projectRunAudit({ run, events, diagnostics: [], salt: "", droppedDiagnosticCount: 0 });
			projectLifecycleDiagnostics(events, { workflowId, salt: "", now: () => 0 });
		});
		return { label: "diagnostics-projection", ms: timedResult.ms };
	} catch {
		return probe;
	}
}

export async function collectTimingBaseline(input: {
	cwd: string;
	workflowRunDir?: string;
}): Promise<TimingBaseline> {
	const loaded = input.workflowRunDir ? loadWorkflowRun(input.workflowRunDir) : undefined;
	const run = loaded ?? createSyntheticTimingRun(input.cwd);
	const contextNode = pickContextPackNode(run) ?? run.nodes.consumer ?? Object.values(run.nodes)[0]!;
	const probes = await Promise.all([
		measureDiscovery(input.cwd),
		measureContextPack(run, contextNode),
		measureSchedulerQueue(run),
		measureDiagnosticsProjection(input.workflowRunDir),
	]);
	const byLabel = Object.fromEntries(probes.map((probe) => [probe.label, probe.ms])) as TimingBaseline["timings"];
	return {
		generatedAt: new Date().toISOString(),
		cwd: input.cwd,
		...(input.workflowRunDir ? { workflowRunDir: input.workflowRunDir } : {}),
		timings: {
			discovery: byLabel.discovery ?? null,
			"context-pack": byLabel["context-pack"] ?? null,
			"scheduler-queue": byLabel["scheduler-queue"] ?? null,
			"diagnostics-projection": byLabel["diagnostics-projection"] ?? null,
		},
		probes,
	};
}

function humanSummary(baseline: TimingBaseline): string {
	const lines = [
		`Timing baseline (${baseline.generatedAt})`,
		`  cwd: ${baseline.cwd}`,
		...(baseline.workflowRunDir ? [`  workflow-run-dir: ${baseline.workflowRunDir}`] : ["  workflow-run-dir: synthetic"]),
	];
	for (const probe of baseline.probes) {
		lines.push(`  ${probe.label}: ${probe.ms === null ? "n/a" : `${probe.ms}ms`}`);
	}
	return lines.join("\n");
}

function parseArgs(argv: string[]) {
	const args = argv.slice(2);
	const jsonIndex = args.indexOf("--json");
	const humanIndex = args.indexOf("--human");
	const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1]?.trim() : undefined;
	const wantHuman = humanIndex >= 0 || jsonIndex < 0;
	const positionals = args.filter((arg, index) => {
		if (arg === "--json" || arg === "--human") return false;
		if (index === jsonIndex + 1) return false;
		return true;
	});
	return {
		jsonPath,
		wantHuman,
		cwd: positionals[0] ? path.resolve(positionals[0]) : process.cwd(),
		workflowRunDir: positionals[1] ? path.resolve(positionals[1]) : undefined,
	};
}

if (import.meta.main) {
	const options = parseArgs(process.argv);
	const baseline = await collectTimingBaseline({
		cwd: options.cwd,
		workflowRunDir: options.workflowRunDir,
	});
	if (options.jsonPath) {
		fs.mkdirSync(path.dirname(path.resolve(options.jsonPath)), { recursive: true });
		fs.writeFileSync(options.jsonPath, `${JSON.stringify(baseline, null, 2)}\n`);
		process.stdout.write(`Timing baseline written to ${options.jsonPath}\n`);
	}
	if (options.wantHuman) {
		process.stdout.write(`${humanSummary(baseline)}\n`);
	}
	if (!options.jsonPath && !options.wantHuman) {
		process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
	}
}
