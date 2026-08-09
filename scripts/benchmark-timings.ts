/**
 * Lightweight timing probes for the expensive pure stages of a workflow run.
 *
 * These are meant for CI regression watching (see the companion
 * `check-benchmark-regression` script): each function measures one isolated
 * stage end-to-end and returns its wall-clock duration in milliseconds. They
 * are intentionally defensive — given an incomplete run they fall back to a
 * zero-cost measurement instead of throwing — so a broken workflow directory
 * never takes down the whole benchmark.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgentsAll } from "../src/agents/agents.ts";
import { createLocalWorkflowArtifactStore } from "../src/workflows/artifact-store.ts";
import { materializeWorkflowContextPack } from "../src/workflows/context-pack.ts";
import { resolveWorkflowMaxNodeAttempts, workflowNodeAttemptsExhausted } from "../src/workflows/retry-policy.ts";
import type { WorkflowNode, WorkflowRun } from "../src/workflows/types.ts";
import { timed } from "./workflow-benchmark.ts";

export interface TimingProbe {
	label: string;
	ms: number | null;
}

/**
 * Measure the cost of discovering all subagents visible from `cwd`.
 *
 * Runs the full discovery pipeline (builtin + user + project + package agent
 * and chain discovery) and reports the wall-clock time. Returns `null` when
 * discovery is unavailable so the caller can skip recording.
 */
export async function measureDiscovery(cwd: string): Promise<TimingProbe> {
	const timedResult = await timed("discovery", async () => {
		discoverAgentsAll(cwd);
	});
	return { label: "discovery", ms: timedResult.ms };
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
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
	return { label: "context-pack", ms: timedResult.ms };
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
				retryNodeIds.has(node.id) &&
				(node.status === "failed" || node.status === "cancelled") &&
				lastFailure?.retryable !== false &&
				!workflowNodeAttemptsExhausted(node, maxNodeAttempts)
			);
		})
		.map((node) => node.id);
}

/**
 * Measure the cost of computing the ready queue for a workflow run.
 */
export async function measureSchedulerQueue(run: WorkflowRun): Promise<TimingProbe> {
	const timedResult = await timed("scheduler-queue", async () => {
		computeReadyQueue(run);
	});
	return { label: "scheduler-queue", ms: timedResult.ms };
}

if (import.meta.main) {
	const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
	const probes = await Promise.all([measureDiscovery(cwd)]);
	for (const probe of probes) {
		process.stdout.write(`${probe.label}: ${probe.ms === null ? "n/a" : `${probe.ms}ms`}\n`);
	}
}