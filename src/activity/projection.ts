import { compactText, sumDefinedNumbers } from "../shared/formatters.ts";
import type { SubagentState } from "../shared/types.ts";
import { collectFleetSnapshot, type FleetItem } from "../tui/fleet.ts";
import { workflowRunLanguage } from "../workflows/language.ts";
import type { WorkflowNode, WorkflowRun } from "../workflows/types.ts";
import type {
	ActivityArtifact,
	ActivityEvent,
	ActivitySnapshot,
	ActivityState,
	ActivityUsage,
	AgentExecutionActivity,
	TaskActivity,
	WorkUnitActivity,
} from "./types.ts";

const TERMINAL = new Set<ActivityState>(["completed", "accepted", "failed", "cancelled", "superseded"]);

function activityState(value: string): ActivityState {
	switch (value) {
		case "running": return "running";
		case "waiting": return "waiting";
		case "ready": return "ready";
		case "queued":
		case "pending": return "pending";
		case "complete":
		case "completed": return "completed";
		case "accepted": return "accepted";
		case "failed":
		case "rejected": return "failed";
		case "paused":
		case "detached": return "paused";
		case "superseded": return "superseded";
		case "cancelled":
		case "stopped": return "cancelled";
		default: return "pending";
	}
}

function compact(value: string | undefined, max = 72): string | undefined {
	const text = compactText(value, max, "…");
	return text || undefined;
}

function compactArgs(value: string | undefined): string | undefined {
	const text = compact(value, 64);
	if (!text) return undefined;
	return text
		.replace(/^\{\s*/, "")
		.replace(/\s*\}$/, "")
		.replace(/"([^"\\]+)"\s*:/g, "$1=")
		.replace(/[\[\]"]/g, "")
		.replace(/\s*,\s*/g, " · ");
}

function itemRunId(item: FleetItem): string {
	return item.runId;
}

function itemExecutionKey(item: FleetItem): string {
	const index = item.kind === "async" ? item.index ?? "run" : item.index ?? 0;
	return `${item.runId}:${index}`;
}

function itemStartedAt(item: FleetItem): number {
	if (item.kind === "foreground-active") return item.activeChild?.startedAt ?? item.control.startedAt;
	if (item.kind === "foreground-recent") return item.child.startedAt ?? item.run.startedAt;
	return item.step?.startedAt ?? item.run.startedAt;
}

function itemDuration(item: FleetItem): number | undefined {
	if (item.kind === "foreground-active") return Math.max(0, Date.now() - (item.activeChild?.startedAt ?? item.control.startedAt));
	if (item.kind === "foreground-recent") return item.child.durationMs;
	if ((item.state === "queued" || item.state === "pending") && item.step && item.step.startedAt === undefined) return undefined;
	const terminal = item.state !== "queued" && item.state !== "running" && item.state !== "pending";
	const end = item.step?.endedAt ?? item.run.endedAt ?? (terminal ? item.run.lastUpdate : Date.now());
	return item.step?.durationMs ?? Math.max(0, end - (item.step?.startedAt ?? item.run.startedAt));
}

function itemUsage(item: FleetItem): ActivityUsage | undefined {
	if (item.kind === "foreground-active") {
		const live = item.activeChild ?? item.control;
		if (live.tokens === undefined && live.inputTokens === undefined && live.outputTokens === undefined && live.toolCount === undefined) return undefined;
		return {
			...(live.inputTokens !== undefined ? { inputTokens: live.inputTokens } : {}),
			...(live.outputTokens !== undefined ? { outputTokens: live.outputTokens } : {}),
			...(live.tokens !== undefined ? { totalTokens: live.tokens } : {}),
			...(live.toolCount !== undefined ? { toolCalls: live.toolCount } : {}),
		};
	}
	if (item.kind === "foreground-recent") {
		const usage = item.child.usage;
		if (!usage && item.child.tokens === undefined && item.child.toolCount === undefined) return undefined;
		return {
			...(usage ? {
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadTokens: usage.cacheRead,
				cacheWriteTokens: usage.cacheWrite,
				totalTokens: usage.input + usage.output,
				costUsd: usage.cost,
			} : item.child.tokens !== undefined ? { totalTokens: item.child.tokens } : {}),
			...(item.child.toolCount !== undefined ? { toolCalls: item.child.toolCount } : {}),
		};
	}
	const tokens = item.step?.tokens ?? (item.index === undefined ? item.run.totalTokens : undefined);
	const cost = item.step?.totalCost ?? (item.index === undefined ? item.run.totalCost : undefined);
	const toolCalls = item.step?.toolCount ?? (item.index === undefined ? item.run.toolCount : undefined);
	if (!tokens && !cost && toolCalls === undefined) return undefined;
	return {
		...(tokens ? { inputTokens: tokens.input, outputTokens: tokens.output, totalTokens: tokens.total } : {}),
		...(cost ? { costUsd: cost.costUsd } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
	};
}

function sumUsage(values: Array<ActivityUsage | undefined>): ActivityUsage | undefined {
	const present = values.filter((value): value is ActivityUsage => value !== undefined);
	if (!present.length) return undefined;
	const sumKnown = (field: keyof ActivityUsage): number | undefined => {
		const known = present.map((value) => value[field]).filter((value): value is number => value !== undefined);
		return known.length ? known.reduce((sum, value) => sum + value, 0) : undefined;
	};
	return {
		...(sumKnown("inputTokens") !== undefined ? { inputTokens: sumKnown("inputTokens") } : {}),
		...(sumKnown("outputTokens") !== undefined ? { outputTokens: sumKnown("outputTokens") } : {}),
		...(sumKnown("cacheReadTokens") !== undefined ? { cacheReadTokens: sumKnown("cacheReadTokens") } : {}),
		...(sumKnown("cacheWriteTokens") !== undefined ? { cacheWriteTokens: sumKnown("cacheWriteTokens") } : {}),
		...(sumKnown("totalTokens") !== undefined ? { totalTokens: sumKnown("totalTokens") } : {}),
		...(sumKnown("costUsd") !== undefined ? { costUsd: sumKnown("costUsd") } : {}),
		...(sumKnown("toolCalls") !== undefined ? { toolCalls: sumKnown("toolCalls") } : {}),
	};
}

function uniqueArtifacts(artifacts: ActivityArtifact[]): ActivityArtifact[] {
	const seen = new Set<string>();
	return artifacts.filter((artifact) => {
		const value = artifact.path.trim();
		if (!value || seen.has(value)) return false;
		seen.add(value);
		return true;
	});
}

function safeArtifactPath(value: string): string | undefined {
	const path = value.trim();
	return path && !/[\x00-\x1f\x7f-\x9f]/.test(path) ? path : undefined;
}

function artifact(path: string | undefined, kind: ActivityArtifact["kind"], label: string, cwd?: string): ActivityArtifact[] {
	const safePath = path === undefined ? undefined : safeArtifactPath(path);
	return safePath ? [{ path: safePath, kind, label, ...(cwd ? { cwd } : {}) }] : [];
}

function fleetArtifacts(item: FleetItem): ActivityArtifact[] {
	if (item.kind === "foreground-active") return [];
	if (item.kind === "foreground-recent") {
		const child = item.child;
		return uniqueArtifacts([
			...artifact(child.savedOutputPath, "evidence", "Output", item.run.cwd),
			...artifact(child.artifactPaths?.outputPath, "evidence", "Output artifact", item.run.cwd),
			...artifact(child.artifactPaths?.inputPath, "run", "Input", item.run.cwd),
			...artifact(child.artifactPaths?.jsonlPath, "run", "Messages", item.run.cwd),
			...artifact(child.transcriptPath ?? child.artifactPaths?.transcriptPath, "run", "Transcript", item.run.cwd),
			...artifact(child.artifactPaths?.metadataPath, "run", "Metadata", item.run.cwd),
			...artifact(child.sessionFile, "run", "Session", item.run.cwd),
		]);
	}
	const cwd = item.run.cwd;
	return uniqueArtifacts([
		...artifact(item.step?.structuredOutputPath, "evidence", "Structured result", cwd),
		...artifact(item.step?.transcriptPath, "run", "Transcript", cwd),
		...artifact(item.step?.sessionFile, "run", "Session", cwd),
		...artifact(item.run.outputFile, "evidence", "Output", cwd),
		...artifact(item.run.sessionFile, "run", "Session", cwd),
	]);
}

function workflowArtifacts(run: WorkflowRun, node: WorkflowNode): ActivityArtifact[] {
	return uniqueArtifacts(node.attempts.flatMap((attempt) => [
		...(attempt.result?.artifactPaths ?? []).flatMap((path) => artifact(path, "evidence", "Evidence", run.cwd)),
		...(attempt.artifactPaths ?? []).flatMap((path) => artifact(path, "run", "Run artifact", run.cwd)),
		...artifact(attempt.structuredOutputPath, "run", "Structured result", run.cwd),
		...artifact(attempt.metadataPath, "run", "Metadata", run.cwd),
	]));
}

function itemActivity(item: FleetItem): { current?: string; recent: ActivityEvent[]; error?: string } {
	const live = item.kind === "foreground-active"
		? item.activeChild ?? item.control
		: item.kind === "foreground-recent"
			? item.child
			: item.step ?? item.run;
	const currentArgs = compactArgs(live.currentToolArgs);
	const current = live.currentTool
		? `${live.currentTool}${currentArgs ? ` · ${currentArgs}` : ""}`
		: [...(live.recentOutput ?? [])].reverse().map((entry) => compact(entry)).find(Boolean)
			?? compact(item.description);
	const recent: ActivityEvent[] = [];
	for (const tool of [...(live.recentTools ?? [])].reverse().slice(0, 3)) {
		const args = compactArgs(tool.args);
		recent.push({ key: `${tool.tool}\0${args ?? ""}`, text: `${tool.tool}${args ? ` · ${args}` : ""}`, state: "completed" });
	}
	for (const output of [...(live.recentOutput ?? [])].reverse()) {
		const text = compact(output);
		if (!text || recent.some((entry) => entry.text === text)) continue;
		recent.push({ key: `output:${text}`, text, state: activityState(item.state) });
		if (recent.length >= 3) break;
	}
	return { current, recent: recent.slice(0, 3), ...(compact((live as { error?: string }).error) ? { error: compact((live as { error?: string }).error) } : {}) };
}

function fleetExecution(item: FleetItem): AgentExecutionActivity {
	const live = itemActivity(item);
	return {
		key: itemExecutionKey(item),
		agent: item.agent,
		state: activityState(item.state),
		startedAt: itemStartedAt(item),
		...(itemDuration(item) !== undefined ? { durationMs: itemDuration(item) } : {}),
		...(itemUsage(item) ? { usage: itemUsage(item) } : {}),
		artifacts: fleetArtifacts(item),
		...(live.current ? { activity: live.current } : {}),
		recent: live.recent,
		inspectKey: item.key,
		attempt: 1,
		...(live.error ? { error: live.error } : {}),
		fleetItem: item,
	};
}

function nodeReason(node: WorkflowNode): string | undefined {
	const attempt = node.attempts.at(-1);
	if (node.status === "failed" || node.status === "cancelled") return compact(attempt?.error);
	if (node.status === "waiting") return compact(attempt?.error);
	return undefined;
}

function aggregate(states: ActivityState[]): ActivityState {
	// A task remains live while any child is running or awaiting a terminal
	// response. A historical sibling failure must not mask that live repair.
	if (states.includes("running")) return "running";
	if (states.includes("waiting")) return "waiting";
	if (states.includes("failed")) return "failed";
	if (states.includes("paused")) return "paused";
	if (states.length > 0 && states.every((state) => state === "completed" || state === "accepted")) return "completed";
	if (states.length > 0 && states.every((state) => TERMINAL.has(state))) return "cancelled";
	if (states.includes("ready")) return "ready";
	return "pending";
}

function taskPath(taskId: string, tasks: WorkflowRun["tasks"]): string {
	const labels: string[] = [];
	const seen = new Set<string>();
	let current = tasks[taskId];
	while (current && !seen.has(current.id)) {
		labels.unshift(current.label);
		seen.add(current.id);
		current = current.parentId ? tasks[current.parentId] : undefined;
	}
	return labels.join(" › ");
}

function workflowExecution(run: WorkflowRun, node: WorkflowNode, fleetByRunId: Map<string, FleetItem>): AgentExecutionActivity {
	const attempt = node.attempts.at(-1);
	const executionRunId = attempt?.childRunId ?? attempt?.requestId;
	const fleetItem = executionRunId ? fleetByRunId.get(executionRunId) : undefined;
	const live = fleetItem ? fleetExecution(fleetItem) : undefined;
	const reason = nodeReason(node);
	const attemptUsage: ActivityUsage | undefined = attempt?.usage ? {
		inputTokens: attempt.usage.input,
		outputTokens: attempt.usage.output,
		cacheReadTokens: attempt.usage.cacheRead,
		cacheWriteTokens: attempt.usage.cacheWrite,
		totalTokens: attempt.usage.input + attempt.usage.output,
		costUsd: attempt.usage.cost,
		toolCalls: attempt.usage.toolCalls,
	} : undefined;
	const durationMs = live?.durationMs ?? attempt?.usage?.durationMs ?? (attempt?.completedAt !== undefined ? Math.max(0, attempt.completedAt - attempt.startedAt) : attempt ? Math.max(0, Date.now() - attempt.startedAt) : undefined);
	return {
		key: `workflow:${run.id}:${node.id}:${attempt?.number ?? 0}`,
		agent: node.agentSpec.baseAgent,
		role: node.agentSpec.role,
		objective: node.agentSpec.objective,
		context: node.agentSpec.context,
		...(node.agentSpec.skills ? { skills: [...node.agentSpec.skills] } : {}),
		...(node.agentSpec.extraTools ? { extraTools: [...node.agentSpec.extraTools] } : {}),
		...(node.agentSpec.denyTools ? { denyTools: [...node.agentSpec.denyTools] } : {}),
		state: activityState(node.status),
		startedAt: attempt?.startedAt ?? run.createdAt,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(attemptUsage ?? live?.usage ? { usage: attemptUsage ?? live?.usage } : {}),
		artifacts: uniqueArtifacts([...workflowArtifacts(run, node), ...(live?.artifacts ?? [])]),
		...(live?.activity ? { activity: live.activity } : {}),
		recent: live?.recent ?? [],
		...(fleetItem ? { inspectKey: fleetItem.key, fleetItem } : {}),
		workUnitId: node.id,
		taskId: node.taskId,
		taskPath: `${taskPath(node.taskId, run.tasks)} › ${node.label}`,
		attempt: attempt?.number ?? 0,
		...(reason ? { error: reason } : {}),
	};
}

function taskActivities(run: WorkflowRun, workUnits: WorkUnitActivity[]): TaskActivity[] {
	const byTask = new Map<string, WorkUnitActivity[]>();
	for (const unit of workUnits) {
		const items = byTask.get(unit.taskId) ?? [];
		items.push(unit);
		byTask.set(unit.taskId, items);
	}
	const built = new Map<string, TaskActivity>();
	const build = (taskId: string): TaskActivity => {
		const cached = built.get(taskId);
		if (cached) return cached;
		const plan = run.tasks[taskId]!;
		const ownUnits = [...(byTask.get(taskId) ?? [])].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
		const children = Object.values(run.tasks)
			.filter((task) => task.parentId === taskId)
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
			.map((task) => build(task.id));
		// Superseded units are intentionally replaced work: they still appear in the tree (dimmed)
		// and keep contributing usage/artifacts/cost, but they must not count toward completion or
		// drag the group into a failed/cancelled aggregate. Only "live" units drive state and ratio.
		const liveUnits = ownUnits.filter((unit) => unit.state !== "superseded");
		const states = [...liveUnits.map((unit) => unit.state), ...children.map((child) => child.state)];
		const completed = liveUnits.filter((unit) => unit.state === "completed" || unit.state === "accepted").length
			+ children.reduce((sum, child) => sum + child.completed, 0);
		const total = liveUnits.length + children.reduce((sum, child) => sum + child.total, 0);
		const durationMs = sumDefinedNumbers([...ownUnits.map((unit) => unit.durationMs), ...children.map((child) => child.durationMs)]);
		const usage = sumUsage([...ownUnits.map((unit) => unit.usage), ...children.map((child) => child.usage)]);
		const artifacts = uniqueArtifacts([...ownUnits.flatMap((unit) => unit.artifacts), ...children.flatMap((child) => child.artifacts)]);
		const task: TaskActivity = {
			id: plan.id,
			label: plan.label,
			...(plan.parentId ? { parentId: plan.parentId } : {}),
			order: plan.order,
			state: aggregate(states),
			workUnits: ownUnits,
			children,
			completed,
			total,
			...(durationMs !== undefined ? { durationMs } : {}),
			...(usage ? { usage } : {}),
			artifacts,
			plan,
		};
		built.set(taskId, task);
		return task;
	};
	return Object.values(run.tasks)
		.filter((task) => !task.parentId)
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
		.map((task) => build(task.id));
}

/**
 * Pure run-only projection of the task tree (no fleet enrichment).
 *
 * Shared by the inline workflow card and the activity dock so both surfaces
 * derive the exact same task state / completed / total / children from the
 * same `taskActivities` aggregation. The card does not need per-execution
 * usage, duration, or artifacts, so it builds work units without fleet lookup.
 */
export function buildTaskActivitiesFromRun(run: WorkflowRun): TaskActivity[] {
	const workUnits = Object.values(run.nodes)
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
		.map((node): WorkUnitActivity => ({
			id: node.id,
			taskId: node.taskId,
			label: node.label,
			order: node.order,
			state: activityState(node.status),
			dependsOn: [...node.dependsOn],
			attempts: node.attempts.length,
			artifacts: [],
			executions: [],
			node,
		}));
	return taskActivities(run, workUnits);
}

export function buildActivitySnapshot(state: SubagentState, run?: WorkflowRun): ActivitySnapshot {
	const fleet = collectFleetSnapshot(state).items;
	const fleetByRunId = new Map(fleet.map((item) => [itemRunId(item), item]));
	const executions: AgentExecutionActivity[] = [];
	let tasks: TaskActivity[] = [];
	if (run) {
		const workUnits = Object.values(run.nodes)
			.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
			.map((node): WorkUnitActivity => {
				const execution = workflowExecution(run, node, fleetByRunId);
				const attemptDurations = node.attempts.map((attempt) => attempt.usage?.durationMs ?? (attempt.completedAt !== undefined ? Math.max(0, attempt.completedAt - attempt.startedAt) : Math.max(0, Date.now() - attempt.startedAt)));
				const latestAttempt = node.attempts.at(-1);
				const attemptUsage = sumUsage([
					...node.attempts.map((attempt) => attempt.usage ? {
						inputTokens: attempt.usage.input,
						outputTokens: attempt.usage.output,
						cacheReadTokens: attempt.usage.cacheRead,
						cacheWriteTokens: attempt.usage.cacheWrite,
						totalTokens: attempt.usage.input + attempt.usage.output,
						costUsd: attempt.usage.cost,
						toolCalls: attempt.usage.toolCalls,
					} : undefined),
					latestAttempt && !latestAttempt.usage ? execution.usage : undefined,
				]);
				if (node.attempts.length > 0) executions.push(execution);
				return {
					id: node.id,
					taskId: node.taskId,
					label: node.label,
					order: node.order,
					state: activityState(node.status),
					dependsOn: [...node.dependsOn],
					attempts: node.attempts.length,
					...(attemptDurations.length ? { durationMs: sumDefinedNumbers(attemptDurations) } : {}),
					...(attemptUsage ? { usage: attemptUsage } : {}),
					artifacts: workflowArtifacts(run, node),
					executions: node.attempts.length > 0 || node.status === "running" || node.status === "waiting" ? [execution] : [],
					...(nodeReason(node) ? { reason: nodeReason(node) } : {}),
					node,
				};
			});
		tasks = taskActivities(run, workUnits);
	}
	const claimedInspectKeys = new Set(executions.map((execution) => execution.inspectKey).filter((value): value is string => Boolean(value)));
	const claimedWorkflowRunIds = new Set(run ? Object.values(run.nodes).flatMap((node) => node.attempts.flatMap((attempt) => [attempt.childRunId, attempt.requestId].filter((value): value is string => Boolean(value)))) : []);
	const independent = fleet.filter((item) => !claimedInspectKeys.has(item.key) && !claimedWorkflowRunIds.has(item.runId)).map(fleetExecution);
	return {
		version: 1,
		language: run ? workflowRunLanguage(run) : "en",
		...(run ? { workflow: { runId: run.id, goal: run.goal, status: run.status, tasks } } : {}),
		executions: [...executions, ...independent],
		independent,
		updatedAt: Date.now(),
	};
}
