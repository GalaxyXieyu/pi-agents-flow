import { randomUUID } from "node:crypto";
import type { ForegroundRunControl } from "../../shared/types.ts";
import { consumeSteerAckAt, readSteerCapabilityAt, steerAckPathFromDir, writeSteerRequestToDir, type SteerRequest } from "../background/control-channel.ts";

export interface ForegroundSteerResult {
	text: string;
	isError?: boolean;
}

function capabilityIsLive(capability: ReturnType<typeof readSteerCapabilityAt>, index: number): boolean {
	if (!capability?.supported || capability.index !== index) return false;
	try {
		process.kill(capability.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function foregroundSteerAvailable(control: ForegroundRunControl | undefined, index: number): boolean {
	const child = control?.activeChildren?.get(index);
	if (!child?.steerCapabilityPath || !child.steerInboxDir || !child.steerAckDir) return false;
	return capabilityIsLive(readSteerCapabilityAt(child.steerCapabilityPath), index);
}

export async function steerForegroundRun(input: {
	control: ForegroundRunControl | undefined;
	index: number;
	message: string;
	timeoutMs?: number;
}): Promise<ForegroundSteerResult> {
	const child = input.control?.activeChildren?.get(input.index);
	if (!child?.steerCapabilityPath || !child.steerInboxDir || !child.steerAckDir) {
		return { text: "Selected foreground child does not expose a steering inbox.", isError: true };
	}
	if (!capabilityIsLive(readSteerCapabilityAt(child.steerCapabilityPath), input.index)) {
		return { text: "Selected foreground child does not support live steering.", isError: true };
	}
	const message = input.message.trim();
	if (!message) return { text: "Steering message must not be empty.", isError: true };
	const request: SteerRequest = { type: "steer", id: randomUUID(), ts: Date.now(), message, targetIndex: input.index, source: "activity-board" };
	writeSteerRequestToDir(child.steerInboxDir, request);
	const ackPath = steerAckPathFromDir(child.steerAckDir, request.id);
	const deadline = Date.now() + (input.timeoutMs ?? 3_000);
	while (Date.now() <= deadline) {
		const ack = consumeSteerAckAt(ackPath);
		if (ack && ack.requestId === request.id && ack.index === input.index) {
			return ack.state === "delivered" ? { text: "Steering delivered to the foreground Agent." } : { text: `Foreground steering failed: ${ack.message}`, isError: true };
		}
		if (!input.control?.activeChildren?.has(input.index) || !capabilityIsLive(readSteerCapabilityAt(child.steerCapabilityPath), input.index)) {
			return { text: "Foreground Agent ended before steering was acknowledged.", isError: true };
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	return input.control?.activeChildren?.has(input.index) && capabilityIsLive(readSteerCapabilityAt(child.steerCapabilityPath), input.index)
		? { text: `Steering queued for foreground Agent (request ${request.id}).` }
		: { text: "Foreground Agent ended before steering was acknowledged.", isError: true };
}

