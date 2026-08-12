import assert from "node:assert/strict";
import { executeHeadlessDecision } from "./src/headless/decision-contract.ts";
import { decisionInputDigest } from "./src/headless/decision-audit.ts";

const baseRequest = {
	kind: "confirmation",
	evidence: { sufficient: true },
	policyVersion: "workflow-v1",
	traceId: "trace-1",
	forbiddenCapabilities: ["funds.transfer"],
};

function decision(overrides = {}) {
	return { verdict: "approve", reason: "ok", confidence: 0.95, model: "m", provider: "p", ...overrides };
}

async function runAttack(provider, requestOverrides = {}) {
	const records = [];
	const result = await executeHeadlessDecision({
		provider,
		request: { ...baseRequest, ...requestOverrides },
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9,
		evidenceSufficient: true,
		policyAllowsApproval: true,
		timeoutMs: 50,
	});
	return { result, records };
}

let attacks = 0, passed = 0;

function check(name, fn) {
	attacks++;
	try { fn(); passed++; console.log(`  PASS: ${name}`); }
	catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); throw e; }
}

async function asyncCheck(name, fn) {
	attacks++;
	try { await fn(); passed++; console.log(`  PASS: ${name}`); }
	catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); throw e; }
}

console.log("\n=== ATTACK 1: Proxy TOCTOU ===");

// 1a: accessor descriptor for structuredAnswer that IS in ownKeys must reject
await asyncCheck("1a: accessor descriptor in ownKeys must reject", async () => {
	const target = decision({ structuredAnswer: {} });
	const hostile = new Proxy(target, {
		getOwnPropertyDescriptor(inner, key) {
			if (key === "structuredAnswer") {
				return { configurable: true, enumerable: true, get: () => ({ allowedTools: ["funds.transfer"] }) };
			}
			return Reflect.getOwnPropertyDescriptor(inner, key);
		},
	});
	const { result } = await runAttack({ async decide() { return hostile; } });
	assert.notEqual(result.verdict, "approve", "accessor descriptor must not approve");
});

// 1b: prototype poisoning
await asyncCheck("1b: prototype poisoning with inherited grant key", async () => {
	const proto = { "allowedTools": ["funds.transfer"] };
	const obj = Object.assign(Object.create(proto), decision({ structuredAnswer: {} }));
	const { result } = await runAttack({ async decide() { return obj; } });
	assert.equal(result.verdict, "reject", "prototype poisoning must reject");
});

// 1c: symbol key injection
await asyncCheck("1c: symbol key injection", async () => {
	const sym = Symbol("grant");
	const obj = decision({ structuredAnswer: { [sym]: "funds.transfer" } });
	const { result } = await runAttack({ async decide() { return obj; } });
	assert.equal(result.verdict, "reject", "symbol key must reject");
});

// 1d: nested Proxy ownKeys mutation
await asyncCheck("1d: nested Proxy ownKeys mutation after snapshot", async () => {
	const nestedTarget = { harmless: true };
	let calls = 0;
	const nested = new Proxy(nestedTarget, {
		ownKeys(inner) {
			calls++;
			return calls === 1 ? Reflect.ownKeys(inner) : Reflect.ownKeys(inner).concat("allowedTools");
		},
		getOwnPropertyDescriptor(inner, key) {
			if (key === "allowedTools" && calls > 1) return { configurable: true, enumerable: true, value: ["funds.transfer"], writable: true };
			return Reflect.getOwnPropertyDescriptor(inner, key);
		},
	});
	const { result } = await runAttack({ async decide() { return decision({ structuredAnswer: { nested } }); } });
	assert.equal(calls, 1, "ownKeys should only be called once");
	assert.equal(result.verdict, "approve", "benign first snapshot should approve");
});

// 1e: classic TOCTOU
await asyncCheck("1e: classic TOCTOU", async () => {
	const target = decision({ structuredAnswer: {} });
	let descCalls = 0;
	const hostile = new Proxy(target, {
		ownKeys(inner) { return Reflect.ownKeys(inner); },
		getOwnPropertyDescriptor(inner, key) {
			if (key === "structuredAnswer") {
				descCalls++;
				return { configurable: true, enumerable: true, value: {}, writable: true };
			}
			return Reflect.getOwnPropertyDescriptor(inner, key);
		},
	});
	const { result } = await runAttack({ async decide() { return hostile; } });
	assert.equal(descCalls, 1);
	assert.equal(result.verdict, "approve", "benign snapshot should approve");
});

// 1f: frozen snapshot
await asyncCheck("1f: frozen snapshot immutability", async () => {
	const { result } = await runAttack({ async decide() { return decision({ structuredAnswer: { answer: "safe" } }); } });
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.structuredAnswer), true);
	assert.throws(() => { result.structuredAnswer.evil = true; }, /frozen|not extensible/i);
});

console.log("\n=== ATTACK 2: digest collisions ===");

check("2a: key-order independence", () => {
	const r1 = { ...baseRequest, evidence: { z: 1, a: 2, m: 3 } };
	const r2 = { ...baseRequest, evidence: { a: 2, m: 3, z: 1 } };
	assert.equal(decisionInputDigest(r1), decisionInputDigest(r2));
});

check("2b: array vs object numeric keys", () => {
	assert.notEqual(
		decisionInputDigest({ ...baseRequest, evidence: [1, 2, 3] }),
		decisionInputDigest({ ...baseRequest, evidence: { "0": 1, "1": 2, "2": 3 } }),
	);
});

check("2c: number vs bigint vs string", () => {
	const d1 = decisionInputDigest({ ...baseRequest, evidence: 1 });
	const d2 = decisionInputDigest({ ...baseRequest, evidence: 1n });
	const d3 = decisionInputDigest({ ...baseRequest, evidence: "1" });
	assert.notEqual(d1, d2);
	assert.notEqual(d1, d3);
	assert.notEqual(d2, d3);
});

check("2d: true vs 1", () => {
	assert.notEqual(
		decisionInputDigest({ ...baseRequest, evidence: true }),
		decisionInputDigest({ ...baseRequest, evidence: 1 }),
	);
});

check("2e: array trailing undefined vs shorter", () => {
	assert.notEqual(
		decisionInputDigest({ ...baseRequest, evidence: ["a", undefined] }),
		decisionInputDigest({ ...baseRequest, evidence: ["a"] }),
	);
});

check("2f: empty object vs empty array", () => {
	assert.notEqual(
		decisionInputDigest({ ...baseRequest, evidence: {} }),
		decisionInputDigest({ ...baseRequest, evidence: [] }),
	);
});

check("2g: unsupported types throw", () => {
	for (const ev of [NaN, Infinity, -Infinity, new Date(0), new Map(), new Set(), () => {}]) {
		assert.throws(() => decisionInputDigest({ ...baseRequest, evidence: ev }), /unsupported/i);
	}
});

await asyncCheck("2h: preflight blocks before provider/audit", async () => {
	const cycle = {}; cycle.self = cycle;
	for (const ev of [new Date(0), new Map(), cycle, NaN, Infinity, Symbol("x")]) {
		let pc = 0, aw = 0;
		await assert.rejects(() => executeHeadlessDecision({
			provider: { async decide() { pc++; return decision(); } },
			request: { ...baseRequest, evidence: ev },
			audit: { write() { aw++; } },
			approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
		}), /unsupported/i);
		assert.equal(pc, 0, `providerCalls should be 0`);
		assert.equal(aw, 0, `auditWrites should be 0`);
	}
});

console.log("\n=== ATTACK 3: audit sink throw ===");

await asyncCheck("3a: sync throw blocks decision", async () => {
	await assert.rejects(() => executeHeadlessDecision({
		provider: { async decide() { return decision(); } },
		request: baseRequest,
		audit: { write() { throw new Error("sync sink dead"); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	}), /sync sink dead/);
});

await asyncCheck("3b: async rejection blocks decision", async () => {
	await assert.rejects(() => executeHeadlessDecision({
		provider: { async decide() { return decision(); } },
		request: baseRequest,
		audit: { async write() { throw new Error("async sink dead"); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	}), /async sink dead/);
});

await asyncCheck("3c: normal path writes exactly once", async () => {
	let aw = 0;
	const result = await executeHeadlessDecision({
		provider: { async decide() { return decision(); } },
		request: baseRequest,
		audit: { write() { aw++; } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.equal(aw, 1);
	assert.equal(result.verdict, "approve");
});

console.log("\n=== ATTACK 4: Unicode redaction ===");

await asyncCheck("4a: full-width Bearer with secret", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision({ reason: "Ｂｅａｒｅｒ sk-abc123secret" }); } },
		request: baseRequest,
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.doesNotMatch(JSON.stringify(records), /sk-abc123secret/);
	assert.equal(records[0].reason, "[redacted]");
});

await asyncCheck("4b: authori.zation with punctuation", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision({ reason: "authori.zation: Bearer xyz" }); } },
		request: baseRequest,
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.doesNotMatch(JSON.stringify(records), /xyz/);
	assert.equal(records[0].reason, "[redacted]");
});

await asyncCheck("4c: raw.prompt in provider field", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision({ provider: "raw.prompt secret-data" }); } },
		request: baseRequest,
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.doesNotMatch(JSON.stringify(records), /secret-data/);
	assert.equal(records[0].provider, "[redacted]");
});

await asyncCheck("4d: NFKC ligature in secret marker", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision({ model: "rawprompt" }); } },
		request: baseRequest,
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.equal(records[0].model, "[redacted]");
});

await asyncCheck("4e: full-width secret in policyVersion", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision(); } },
		request: { ...baseRequest, policyVersion: "ｓｅｃｒｅｔ real-value" },
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.doesNotMatch(JSON.stringify(records), /real-value/);
	assert.equal(records[0].policyVersion, "[redacted]");
});

await asyncCheck("4f: mixed obfuscation in traceId", async () => {
	const records = [];
	await executeHeadlessDecision({
		provider: { async decide() { return decision(); } },
		request: { ...baseRequest, traceId: "ａｃｃｅｓｓ．ｔｏｋｅｎ leaked-key" },
		audit: { write(r) { records.push(r); } },
		approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50,
	});
	assert.doesNotMatch(JSON.stringify(records), /leaked-key/);
	assert.equal(records[0].traceId, "[redacted]");
});

console.log(`\n=== RESULTS: ${passed}/${attacks} attacks passed ===`);
if (passed !== attacks) process.exit(1);
