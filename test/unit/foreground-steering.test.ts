import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { foregroundSteerAvailable, steerForegroundRun } from "../../src/runs/foreground/foreground-steering.ts";
import { steerAckPathFromDir, writeSteerAckAt } from "../../src/runs/background/control-channel.ts";
import type { ForegroundRunControl } from "../../src/shared/types.ts";

function control(root: string, supported: boolean): ForegroundRunControl {
	const steerInboxDir = path.join(root, "targets", "0");
	const steerCapabilityPath = path.join(root, "capabilities", "0.json");
	const steerAckDir = path.join(root, "acks", "0");
	fs.mkdirSync(path.dirname(steerCapabilityPath), { recursive: true });
	fs.writeFileSync(steerCapabilityPath, JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 0, pid: process.pid, readyAt: Date.now(), supported }));
	return {
		runId: "workflow-child",
		mode: "single",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		steeringDir: root,
		activeChildren: new Map([[0, { index: 0, agent: "writer", startedAt: Date.now(), updatedAt: Date.now(), steerInboxDir, steerCapabilityPath, steerAckDir }]]),
	};
}

describe("foreground steering", () => {
	it("delivers a correlated request through the child inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-steer-"));
		try {
			const foreground = control(root, true);
			assert.equal(foregroundSteerAvailable(foreground, 0), true);
			const child = foreground.activeChildren!.get(0)!;
			const acknowledge = setInterval(() => {
				if (!fs.existsSync(child.steerInboxDir!)) return;
				const entry = fs.readdirSync(child.steerInboxDir!).find((name) => name.endsWith(".json"));
				if (!entry) return;
				const request = JSON.parse(fs.readFileSync(path.join(child.steerInboxDir!, entry), "utf-8")) as { id: string };
				writeSteerAckAt(steerAckPathFromDir(child.steerAckDir!, request.id), { requestId: request.id, index: 0, ts: Date.now(), state: "delivered", message: "accepted" });
				clearInterval(acknowledge);
			}, 10);
			const result = await steerForegroundRun({ control: foreground, index: 0, message: "Focus on the evidence gap", timeoutMs: 500 });
			clearInterval(acknowledge);
			assert.deepEqual(result, { text: "Steering delivered to the foreground Agent." });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects mismatched capability and acknowledgment identities", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-steer-"));
		try {
			const foreground = control(root, true);
			const child = foreground.activeChildren!.get(0)!;
			fs.writeFileSync(child.steerCapabilityPath!, JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 999, pid: process.pid, readyAt: Date.now(), supported: true }));
			assert.equal(foregroundSteerAvailable(foreground, 0), false);
			fs.writeFileSync(child.steerCapabilityPath!, JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 0, pid: process.pid, readyAt: Date.now(), supported: true }));
			const acknowledge = setInterval(() => {
				if (!fs.existsSync(child.steerInboxDir!)) return;
				const entry = fs.readdirSync(child.steerInboxDir!).find((name) => name.endsWith(".json"));
				if (!entry) return;
				const request = JSON.parse(fs.readFileSync(path.join(child.steerInboxDir!, entry), "utf-8")) as { id: string };
				writeSteerAckAt(steerAckPathFromDir(child.steerAckDir!, request.id), { requestId: "wrong-request", index: 7, ts: Date.now(), state: "delivered", message: "wrong" });
				foreground.activeChildren!.delete(0);
				clearInterval(acknowledge);
			}, 10);
			const result = await steerForegroundRun({ control: foreground, index: 0, message: "test", timeoutMs: 500 });
			clearInterval(acknowledge);
			assert.equal(result.isError, true);
			assert.match(result.text, /ended before steering was acknowledged/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a stale capability from an exited process attempt", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-steer-"));
		try {
			const foreground = control(root, true);
			const child = foreground.activeChildren!.get(0)!;
			fs.writeFileSync(child.steerCapabilityPath!, JSON.stringify({ type: "steer-capability", protocolVersion: 1, index: 0, pid: 2_147_483_647, readyAt: Date.now(), supported: true }));
			assert.equal(foregroundSteerAvailable(foreground, 0), false);
			const result = await steerForegroundRun({ control: foreground, index: 0, message: "try" });
			assert.equal(result.isError, true);
			assert.match(result.text, /does not support live steering/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a child that reports steering unsupported", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-steer-"));
		try {
			const foreground = control(root, false);
			assert.equal(foregroundSteerAvailable(foreground, 0), false);
			const result = await steerForegroundRun({ control: foreground, index: 0, message: "try" });
			assert.equal(result.isError, true);
			assert.match(result.text, /does not support live steering/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
