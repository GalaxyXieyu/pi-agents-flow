import assert from "node:assert/strict";
import { executeHeadlessDecision } from "./src/headless/decision-contract.ts";
import { decisionInputDigest } from "./src/headless/decision-audit.ts";

const baseRequest = { kind: "confirmation", evidence: { sufficient: true }, policyVersion: "workflow-v1", traceId: "trace-1", forbiddenCapabilities: ["funds.transfer"] };
function decision(overrides = {}) { return { verdict: "approve", reason: "ok", confidence: 0.95, model: "m", provider: "p", ...overrides }; }
async function runAttack(provider, requestOverrides = {}) {
	const records = [];
	const result = await executeHeadlessDecision({ provider, request: { ...baseRequest, ...requestOverrides }, audit: { write(r) { records.push(r); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 });
	return { result, records };
}
let attacks = 0, passed = 0;
function check(name, fn) { attacks++; try { fn(); passed++; console.log(`  PASS: ${name}`); } catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); throw e; } }
async function asyncCheck(name, fn) { attacks++; try { await fn(); passed++; console.log(`  PASS: ${name}`); } catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); throw e; } }

console.log("\n=== ATTACK 1: Proxy TOCTOU ===");
await asyncCheck("1a: accessor descriptor in ownKeys must reject", async () => {
	const hostile = new Proxy(decision({ structuredAnswer: {} }), { getOwnPropertyDescriptor(i, k) { if (k === "structuredAnswer") return { configurable: true, enumerable: true, get: () => ({ allowedTools: ["funds.transfer"] }) }; return Reflect.getOwnPropertyDescriptor(i, k); } });
	const { result } = await runAttack({ async decide() { return hostile; } });
	assert.notEqual(result.verdict, "approve");
});
await asyncCheck("1b: prototype poisoning", async () => {
	const obj = Object.assign(Object.create({ allowedTools: ["funds.transfer"] }), decision({ structuredAnswer: {} }));
	const { result } = await runAttack({ async decide() { return obj; } });
	assert.equal(result.verdict, "reject");
});
await asyncCheck("1c: symbol key injection", async () => {
	const sym = Symbol("grant");
	const { result } = await runAttack({ async decide() { return decision({ structuredAnswer: { [sym]: "funds.transfer" } }); } });
	assert.equal(result.verdict, "reject");
});
await asyncCheck("1d: nested Proxy ownKeys mutation", async () => {
	let calls = 0;
	const nested = new Proxy({ harmless: true }, { ownKeys(i) { calls++; return calls === 1 ? Reflect.ownKeys(i) : Reflect.ownKeys(i).concat("allowedTools"); }, getOwnPropertyDescriptor(i, k) { if (k === "allowedTools" && calls > 1) return { configurable: true, enumerable: true, value: ["funds.transfer"], writable: true }; return Reflect.getOwnPropertyDescriptor(i, k); } });
	const { result } = await runAttack({ async decide() { return decision({ structuredAnswer: { nested } }); } });
	assert.equal(calls, 1);
	assert.equal(result.verdict, "approve");
});
await asyncCheck("1e: classic TOCTOU", async () => {
	let dc = 0;
	const hostile = new Proxy(decision({ structuredAnswer: {} }), { ownKeys(i) { return Reflect.ownKeys(i); }, getOwnPropertyDescriptor(i, k) { if (k === "structuredAnswer") { dc++; return { configurable: true, enumerable: true, value: {}, writable: true }; } return Reflect.getOwnPropertyDescriptor(i, k); } });
	const { result } = await runAttack({ async decide() { return hostile; } });
	assert.equal(dc, 1);
	assert.equal(result.verdict, "approve");
});
await asyncCheck("1f: frozen snapshot", async () => {
	const { result } = await runAttack({ async decide() { return decision({ structuredAnswer: { answer: "safe" } }); } });
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.structuredAnswer), true);
});

console.log("\n=== ATTACK 2: digest collisions ===");
check("2a: key-order independence", () => { assert.equal(decisionInputDigest({ ...baseRequest, evidence: { z: 1, a: 2 } }), decisionInputDigest({ ...baseRequest, evidence: { a: 2, z: 1 } })); });
check("2b: array vs object", () => { assert.notEqual(decisionInputDigest({ ...baseRequest, evidence: [1, 2] }), decisionInputDigest({ ...baseRequest, evidence: { "0": 1, "1": 2 } })); });
check("2c: number vs bigint vs string", () => { const d1 = decisionInputDigest({ ...baseRequest, evidence: 1 }); const d2 = decisionInputDigest({ ...baseRequest, evidence: 1n }); const d3 = decisionInputDigest({ ...baseRequest, evidence: "1" }); assert.notEqual(d1, d2); assert.notEqual(d1, d3); assert.notEqual(d2, d3); });
check("2d: true vs 1", () => { assert.notEqual(decisionInputDigest({ ...baseRequest, evidence: true }), decisionInputDigest({ ...baseRequest, evidence: 1 })); });
check("2e: trailing undefined vs shorter", () => { assert.notEqual(decisionInputDigest({ ...baseRequest, evidence: ["a", undefined] }), decisionInputDigest({ ...baseRequest, evidence: ["a"] })); });
check("2f: empty obj vs empty array", () => { assert.notEqual(decisionInputDigest({ ...baseRequest, evidence: {} }), decisionInputDigest({ ...baseRequest, evidence: [] })); });
check("2g: unsupported throw", () => { for (const ev of [NaN, Infinity, -Infinity, new Date(0), new Map(), new Set(), () => {}]) { assert.throws(() => decisionInputDigest({ ...baseRequest, evidence: ev }), /unsupported/i); } });
await asyncCheck("2h: preflight blocks before provider/audit", async () => {
	const cycle = {}; cycle.self = cycle;
	for (const ev of [new Date(0), new Map(), cycle, NaN, Infinity, Symbol("x")]) {
		let pc = 0, aw = 0;
		await assert.rejects(() => executeHeadlessDecision({ provider: { async decide() { pc++; return decision(); } }, request: { ...baseRequest, evidence: ev }, audit: { write() { aw++; } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }), /unsupported/i);
		assert.equal(pc, 0); assert.equal(aw, 0);
	}
});

console.log("\n=== ATTACK 3: audit sink throw ===");
await asyncCheck("3a: sync throw blocks", async () => { await assert.rejects(() => executeHeadlessDecision({ provider: { async decide() { return decision(); } }, request: baseRequest, audit: { write() { throw new Error("sync sink dead"); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }), /sync sink dead/); });
await asyncCheck("3b: async reject blocks", async () => { await assert.rejects(() => executeHeadlessDecision({ provider: { async decide() { return decision(); } }, request: baseRequest, audit: { async write() { throw new Error("async sink dead"); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }), /async sink dead/); });
await asyncCheck("3c: normal writes once", async () => { let aw = 0; const r = await executeHeadlessDecision({ provider: { async decide() { return decision(); } }, request: baseRequest, audit: { write() { aw++; } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.equal(aw, 1); assert.equal(r.verdict, "approve"); });

console.log("\n=== ATTACK 4: Unicode redaction ===");
await asyncCheck("4a: full-width Bearer", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision({ reason: "Ｂｅａｒｅｒ sk-abc123secret" }); } }, request: baseRequest, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.doesNotMatch(JSON.stringify(r), /sk-abc123secret/); assert.equal(r[0].reason, "[redacted]"); });
await asyncCheck("4b: authori.zation", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision({ reason: "authori.zation: Bearer xyz" }); } }, request: baseRequest, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.doesNotMatch(JSON.stringify(r), /xyz/); assert.equal(r[0].reason, "[redacted]"); });
await asyncCheck("4c: raw.prompt in provider", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision({ provider: "raw.prompt secret-data" }); } }, request: baseRequest, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.doesNotMatch(JSON.stringify(r), /secret-data/); assert.equal(r[0].provider, "[redacted]"); });
await asyncCheck("4d: NFKC ligature", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision({ model: "rawprompt" }); } }, request: baseRequest, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.equal(r[0].model, "[redacted]"); });
await asyncCheck("4e: full-width secret in policyVersion", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision(); } }, request: { ...baseRequest, policyVersion: "ｓｅｃｒｅｔ real-value" }, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.doesNotMatch(JSON.stringify(r), /real-value/); assert.equal(r[0].policyVersion, "[redacted]"); });
await asyncCheck("4f: mixed obfuscation in traceId", async () => { const r = []; await executeHeadlessDecision({ provider: { async decide() { return decision(); } }, request: { ...baseRequest, traceId: "ａｃｃｅｓｓ．ｔｏｋｅｎ leaked-key" }, audit: { write(x) { r.push(x); } }, approveThreshold: 0.9, evidenceSufficient: true, policyAllowsApproval: true, timeoutMs: 50 }); assert.doesNotMatch(JSON.stringify(r), /leaked-key/); assert.equal(r[0].traceId, "[redacted]"); });

console.log(`\n=== RESULTS: ${passed}/${attacks} attacks passed ===`);
if (passed !== attacks) process.exit(1);
