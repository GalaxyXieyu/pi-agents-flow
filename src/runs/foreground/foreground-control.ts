import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProgress, ForegroundChildControl, ForegroundRunControl, SubagentState } from "../../shared/types.ts";

interface BeginForegroundChildInput {
	index: number;
	agent: string;
	description?: string;
	model?: string;
	thinking?: string;
	steerInboxDir?: string;
	steerCapabilityPath?: string;
	steerAckDir?: string;
	interrupt: () => boolean;
	detach?: () => boolean;
}

function copyProgress(target: ForegroundChildControl, progress: AgentProgress | undefined): void {
	if (!progress) return;
	target.currentActivityState = progress.activityState;
	target.lastActivityAt = progress.lastActivityAt;
	target.currentTool = progress.currentTool;
	target.currentToolArgs = progress.currentToolArgs;
	target.currentToolStartedAt = progress.currentToolStartedAt;
	target.currentPath = progress.currentPath;
	target.recentTools = progress.recentTools.map((tool) => ({ ...tool }));
	target.recentOutput = [...progress.recentOutput];
	target.turnCount = progress.turnCount;
	target.tokens = progress.tokens;
	target.inputTokens = progress.inputTokens;
	target.outputTokens = progress.outputTokens;
	target.model = progress.model;
	target.thinking = progress.thinking;
	target.toolCount = progress.toolCount;
}

function syncCurrentChild(control: ForegroundRunControl, child: ForegroundChildControl): void {
	control.currentAgent = child.agent;
	control.currentIndex = child.index;
	control.description = child.description;
	control.currentActivityState = child.currentActivityState;
	control.lastActivityAt = child.lastActivityAt;
	control.currentTool = child.currentTool;
	control.currentToolArgs = child.currentToolArgs;
	control.currentToolStartedAt = child.currentToolStartedAt;
	control.currentPath = child.currentPath;
	control.recentTools = child.recentTools?.map((tool) => ({ ...tool }));
	control.recentOutput = child.recentOutput ? [...child.recentOutput] : undefined;
	control.turnCount = child.turnCount;
	control.tokens = child.tokens;
	control.inputTokens = child.inputTokens;
	control.outputTokens = child.outputTokens;
	control.model = child.model;
	control.thinking = child.thinking;
	control.toolCount = child.toolCount;
	control.interrupt = child.interrupt;
	control.detach = child.detach;
	control.updatedAt = child.updatedAt;
}

function clearCurrentChild(control: ForegroundRunControl): void {
	control.currentAgent = undefined;
	control.currentIndex = undefined;
	control.currentActivityState = undefined;
	control.lastActivityAt = undefined;
	control.currentTool = undefined;
	control.currentToolArgs = undefined;
	control.currentToolStartedAt = undefined;
	control.currentPath = undefined;
	control.recentTools = undefined;
	control.recentOutput = undefined;
	control.turnCount = undefined;
	control.tokens = undefined;
	control.inputTokens = undefined;
	control.outputTokens = undefined;
	control.model = undefined;
	control.thinking = undefined;
	control.toolCount = undefined;
	control.interrupt = undefined;
	control.detach = undefined;
}

export function retainForegroundSchedulingOwner(control: ForegroundRunControl): void {
	control.schedulingOwners = (control.schedulingOwners ?? 0) + 1;
	control.updatedAt = Date.now();
}

export function settleForegroundSchedulingOwner(control: ForegroundRunControl): void {
	control.schedulingOwners = Math.max(0, (control.schedulingOwners ?? 0) - 1);
	control.updatedAt = Date.now();
}

export function foregroundSchedulingSettled(control: ForegroundRunControl): boolean {
	return (control.schedulingOwners ?? 0) === 0;
}

export function foregroundSteeringCleanupKey(steeringDir: string): string {
	return `foreground-steer:${steeringDir}`;
}

export function trackForegroundSteeringCleanup(state: Pick<SubagentState, "foregroundSteeringCleanupDirs">, key: string, steeringDir: string): void {
	state.foregroundSteeringCleanupDirs ??= new Map();
	state.foregroundSteeringCleanupDirs.set(key, steeringDir);
}

export function forgetForegroundSteeringCleanup(state: Pick<SubagentState, "foregroundSteeringCleanupDirs">, key: string): void {
	state.foregroundSteeringCleanupDirs?.delete(key);
}

export function cleanupForegroundSteeringDirs(state: Pick<SubagentState, "foregroundSteeringCleanupDirs">): void {
	for (const steeringDir of state.foregroundSteeringCleanupDirs?.values() ?? []) {
		fs.rmSync(steeringDir, { recursive: true, force: true });
	}
	state.foregroundSteeringCleanupDirs?.clear();
}

export function foregroundSteeringPaths(control: ForegroundRunControl | undefined, index: number): { steerInboxDir: string; steerCapabilityPath: string; steerAckDir: string } | undefined {
	if (!control?.steeringDir) return undefined;
	return {
		steerInboxDir: path.join(control.steeringDir, "targets", String(index)),
		steerCapabilityPath: path.join(control.steeringDir, "capabilities", `${index}.json`),
		steerAckDir: path.join(control.steeringDir, "acks", String(index)),
	};
}

export function beginForegroundChild(control: ForegroundRunControl, input: BeginForegroundChildInput): void {
	const now = Date.now();
	const child: ForegroundChildControl = {
		index: input.index,
		agent: input.agent,
		...(input.description ? { description: input.description } : {}),
		startedAt: now,
		updatedAt: now,
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
		...(input.steerInboxDir ? { steerInboxDir: input.steerInboxDir } : {}),
		...(input.steerCapabilityPath ? { steerCapabilityPath: input.steerCapabilityPath } : {}),
		...(input.steerAckDir ? { steerAckDir: input.steerAckDir } : {}),
	};
	child.interrupt = () => {
		if (!input.interrupt()) return false;
		child.currentActivityState = undefined;
		child.updatedAt = Date.now();
		syncCurrentChild(control, child);
		return true;
	};
	if (input.detach) {
		child.detach = () => {
			if (!input.detach?.()) return false;
			child.currentActivityState = undefined;
			child.updatedAt = Date.now();
			syncCurrentChild(control, child);
			return true;
		};
	}
	control.activeChildren ??= new Map();
	control.activeChildren.set(input.index, child);
	syncCurrentChild(control, child);
}

export function updateForegroundChild(control: ForegroundRunControl, index: number, progress: AgentProgress | undefined): void {
	const child = control.activeChildren?.get(index);
	if (!child) return;
	copyProgress(child, progress);
	child.updatedAt = Date.now();
	syncCurrentChild(control, child);
}

export function finishForegroundChild(control: ForegroundRunControl, index: number): void {
	control.activeChildren?.delete(index);
	if (control.currentIndex === index) {
		const next = [...(control.activeChildren?.values() ?? [])]
			.sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index)[0];
		if (next) syncCurrentChild(control, next);
		else clearCurrentChild(control);
	}
	control.updatedAt = Date.now();
}
