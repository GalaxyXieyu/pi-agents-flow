#!/usr/bin/env node
/**
 * dependency-cruiser SCC baseline 增长校验 —— pi-agents-flow T5
 *
 * 目的：在 `check:deps:ci` 中作为「禁止新增 value SCC」的准入闸门。
 * 方法：
 *   1. 加载 `.dependency-cruiser.cjs` 并在 ruleSet 中注入一个 `circular` 规则。
 *   2. 对 `src/**` 跑一次依赖巡航，提取所有被检测到的 value SCC（强连通分量）
 *      的成员集合（type-only SCC 因 `tsPreCompilationDeps: false` 不会进入 value 环检测）。
 *   3. 将检测到的 SCC 成员集合与已登记的 BASELINE 集合比对：
 *        - 每个检测到的 SCC 都命中 BASELINE → 通过（历史结构，允许）。
 *        - 出现未登记的 SCC → 判定为「新增 value SCC」→ 失败（exit 1）。
 *
 * 退出码：0 = 通过；1 = 存在新增 value SCC 或巡航失败。
 *
 * 维护：新增合法历史 SCC 时，将相应成员集合加入下方 `BASELINE` 数组，
 * 或运行 `node scripts/check-dependency-baseline.mjs --update` 打印当前全部集合供人工登记。
 */
import { createRequire } from "node:module";
import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 登记的 value SCC baseline（成员为 src 相对路径，规范化后按字典序排序）
//
// 来源：t5-recon scc-baseline + dependency-cruiser 实际检测复核。
//   - SCC-1  value: shared/settings ↔ shared/utils ↔ shared/formatters ↔ agents/skills（t5-recon 唯一 value SCC）
//   - SCC-A  value: agents/agents-config ↔ agents/agent-memory ↔ agents/agents ↔ agents/agent-discovery
//                  （t5-recon 未列，dependency-cruiser 检出为历史 value 环，一并登记）
//   - SCC-B  value: runs/foreground/executor-control ↔ runs/foreground/executor-path-parallel-helpers
//                  （t5-recon 未列，dependency-cruiser 检出为历史 value 环，一并登记）
//
// type-only SCC（SCC-2: shared/types↔agents↔runs/shared；SCC-3: workflows/types↔policy）
// 因全部为 `import type` 而不进入 value 环检测，故无需登记于此处（天然豁免）。
// ---------------------------------------------------------------------------
const BASELINE = [
	[
		"src/agents/skills.ts",
		"src/shared/formatters.ts",
		"src/shared/settings.ts",
		"src/shared/utils.ts",
	], // SCC-1
	[
		"src/agents/agent-discovery.ts",
		"src/agents/agent-memory.ts",
		"src/agents/agents.ts",
		"src/agents/agents-config.ts",
	], // SCC-A
	[
		"src/runs/foreground/executor-control.ts",
		"src/runs/foreground/executor-path-parallel-helpers.ts",
	], // SCC-B
];

/** 规范化一个 cycle：取成员 source 的 src 相对路径，排序，去重。 */
function normalizeCycle(cycle) {
	const sources = [];
	for (const member of cycle) {
		const raw = member?.source ?? member?.name ?? String(member);
		// 归一化：保留 "src/..." 相对路径
		let src = raw.replace(/^\.?\//, "");
		if (src.startsWith("/Users/") || src.startsWith(process.cwd())) {
			const idx = src.indexOf("/src/");
			src = idx >= 0 ? src.slice(idx + 1) : src;
		}
		if (!src.startsWith("src/")) src = `src/${src}`;
		sources.push(src);
	}
	return [...new Set(sources)].sort();
}

/** 从一个 cruise JSON 结果中提取所有 value 环成员集合（基于 `dep.circular` + `dep.cycle`）。 */
function extractCycles(cruiseResult) {
	const cycles = new Map(); // key: 规范化集合 JSON，自动去重
	for (const mod of cruiseResult.modules ?? []) {
		for (const dep of mod.dependencies ?? []) {
			if (dep.circular !== true || !Array.isArray(dep.cycle) || dep.cycle.length === 0) {
				continue;
			}
			const members = normalizeCycle(dep.cycle);
			const key = JSON.stringify(members);
			cycles.set(key, members);
		}
	}
	return [...cycles.values()];
}

/**
 * 判断一个检测到的环是否被 baseline 覆盖：其成员集合是某个 baseline SCC 的子集。
 * dependency-cruiser 报告的是基本环（同一 SCC 内会报多个子环），因此用子集判定，
 * 只有「不属于任何已登记 SCC」的环才视为新增/扩张 SCC。
 */
function isCoveredByBaseline(cycleMembers, baselineSccs) {
	const members = new Set(cycleMembers);
	// detected ⊆ baseline：检测到的每个成员都落在某个已登记 SCC 内
	return baselineSccs.some((baseline) =>
		[...members].every((m) => baseline.includes(m)),
	);
}

async function main() {
	const updateMode = process.argv.includes("--update");

	let config;
	try {
		config = require("../.dependency-cruiser.cjs");
	} catch (error) {
		console.error("✖ 无法加载 .dependency-cruiser.cjs：", error.message);
		process.exit(1);
	}

	const options = {
		...config.options,
		ruleSet: {
			forbidden: [
				...config.forbidden,
				{
					name: "no-new-value-cycle",
					severity: "error",
					from: {},
					to: { circular: true },
				},
			],
		},
		outputType: "json",
		includeOnly: "^src",
	};

	let result;
	try {
		result = await cruise(["src"], options);
	} catch (error) {
		console.error("✖ dependency-cruiser 巡航失败：", error.message);
		process.exit(1);
	}

	let cruiseJson;
	try {
		cruiseJson = JSON.parse(result.output);
	} catch (error) {
		console.error("✖ 无法解析巡航输出：", error.message);
		process.exit(1);
	}

	const detected = extractCycles(cruiseJson);
	const baselineSccs = BASELINE.map((c) => [...c].sort());

	if (updateMode) {
		console.log("当前检测到的 value 环（可人工登记到 BASELINE 的 SCC）：");
		for (const c of detected) console.log("  -", JSON.stringify(c));
		return;
	}

	const newSccs = detected.filter((c) => !isCoveredByBaseline(c, baselineSccs));

	console.log("──────────────────────────────────────────────────");
	console.log(`dependency-cruiser SCC baseline 校验`);
	console.log(`检测到 value 环：${detected.length} 个`);
	console.log(`已登记 baseline SCC：${BASELINE.length} 个`);
	console.log("──────────────────────────────────────────────────");

	if (newSccs.length === 0) {
		console.log("✔ 未检测到新增 value SCC（历史 SCC 均在 baseline 内）。");
		return;
	}

	console.error("✖ 检测到新增/扩张的 value SCC（未被 baseline 覆盖）：");
	for (const c of newSccs) {
		console.error("  -", JSON.stringify(c));
	}
	console.error(
		"请解耦该环，或在确认是合法历史结构后登记到 scripts/check-dependency-baseline.mjs 的 BASELINE。",
	);
	process.exit(1);
}

main();
