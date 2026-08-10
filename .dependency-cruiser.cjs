/**
 * dependency-cruiser 架构依赖治理配置 —— pi-agents-flow T5
 *
 * 准入基线来源：`t5-recon` 的 SCC 与边界 baseline（inline `scc-baseline`）。
 * 本配置对 `src/**` 的 import 拓扑做架构护栏：
 *   - 低噪声规则立即阻断（severity: error）
 *   - 历史 SCC 与兼容 facade 用「精确 from/to + baseline 登记」管理，不设全量
 *     `src/** circular` error（详见 `scripts/check-dependency-baseline.mjs`）
 *   - 历史越层方向（shared→runs/agents、workflows→tui/extension）先 advisory
 *     （severity: warn），不阻断 CI
 *
 * 关键约定：
 *   - 本项目为 native ESM + Node 22 `--experimental-strip-types`，import 均显式携带
 *     `.ts` 后缀（如 `import { x } from "../shared/utils.ts"`）。
 *   - 外部依赖为 optional peerDependencies（`@earendil-works/*`）+ dependencies
 *     （`jiti`/`typebox`/`yaml`），按 subpath exports 多入口（package.json `exports`）。
 *   - 运行时/value 依赖 = 非 `import type` 的静态 import；type-only 依赖 =
 *     `import type`（dependency-cruiser 默认 `tsPreCompilationDeps: false`，因此
 *     type-only SCC（SCC-2/SCC-3）不会进入 value 环检测，天然豁免）。
 */
"use strict";

module.exports = {
	forbidden: [
		// ------------------------------------------------------------------
		// 1) 低噪声规则：立即阻断（error）
		// ------------------------------------------------------------------

		{
			name: "no-unresolved",
			comment:
				"依赖无法解析到磁盘（src 内 must resolve；npm 包须声明在 package.json）。",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
		{
			name: "no-undeclared",
			comment:
				"使用了未声明在 package.json 的 npm 依赖。optional peerDependencies(" +
				"@earendil-works/*) 与 dependencies(jiti/typebox/yaml) 视为已声明。",
			severity: "error",
			from: {},
			to: {
				dependencyTypes: ["npm-no-pkg", "npm-unknown"],
				dependencyTypesNot: [
					"npm",
					"npm-peer",
					"npm-dev",
					"npm-optional",
					"npm-bundled",
				],
			},
		},
		{
			name: "no-src-to-test-or-script",
			comment: "src 业务代码不得反向导入 test/ 或 scripts/。",
			severity: "error",
			from: { path: "^src" },
			to: { path: "^(test|scripts)" },
		},
		{
			name: "no-production-to-extension-index",
			comment:
				"生产模块不得反向导入扩展入口 src/extension/index.ts（仅根 index.ts 作为包入口合法 re-export）。",
			severity: "error",
			from: {
				pathNot:
					"^(?:src/extension/index\\.ts|index\\.ts)$",
			},
			to: { path: "^src/extension/index\\.ts$" },
		},
		{
			name: "no-api-to-tui-slash-extension",
			comment: "src/api 后台/委托/预检不得依赖 tui/slash/extension（UI/桥接层）。",
			severity: "error",
			from: { path: "^src/api" },
			to: { path: "^src/(tui|slash|extension)" },
		},
		{
			name: "no-runs-shared-to-foreground",
			comment:
				"runs/shared 共享逻辑不得新增对 runs/foreground 前台执行器的运行时依赖（当前 0 边，禁止新增）。",
			severity: "error",
			from: { path: "^src/runs/shared" },
			to: { path: "^src/runs/foreground" },
		},
		{
			name: "no-background-to-foreground",
			comment:
				"runs/background 后台执行不得新增对 runs/foreground 前台执行器的运行时依赖（当前仅 type-only 边）。",
			severity: "error",
			from: { path: "^src/runs/background" },
			to: { path: "^src/runs/foreground" },
		},

		// ------------------------------------------------------------------
		// 2) 历史越层方向：advisory（warn），不阻断 CI
		// ------------------------------------------------------------------

		{
			name: "advisory-shared-cross-layer",
			comment:
				"shared 层运行时反向 import runs/agents（历史越层，advisory）。" +
				"已登记豁免：shared/{settings,utils}.ts 对 runs/shared/parallel-utils.ts 的" +
				"兼容 facade re-export（G1）；SCC-1 边 shared/settings.ts→agents/skills.ts" +
				"由 baseline 脚本登记。本规则只拦 shared 其它文件的新增越层。",
			severity: "warn",
			from: {
				path: "^src/shared",
				pathNot: "^src/shared/(settings|utils)\\.ts$",
			},
			to: { path: "^src/(runs|agents)" },
		},
		{
			name: "advisory-workflow-to-tui-extension",
			comment:
				"workflows 反向 import tui/extension（历史双向跨包，advisory；允许双向但禁止 cross-package 成环，成环由 baseline 脚本兜底）。",
			severity: "warn",
			from: { path: "^src/workflows" },
			to: { path: "^src/(tui|extension)" },
		},
	],

	options: {
		doNotFollow: {
			path: "node_modules",
			dependencyTypes: [
				"npm",
				"npm-dev",
				"npm-optional",
				"npm-peer",
				"npm-bundled",
				"npm-no-pkg",
			],
		},
		enhancedResolveOptions: {
			// native ESM + 显式 .ts import；subpath exports 走 package.json `exports`
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "node", "default"],
			extensions: [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", ".node"],
		},
		externalModuleResolutionStrategy: "node_modules",
		moduleSystems: ["es6", "cjs", "tsd", "amd"],
		tsPreCompilationDeps: false, // type-only 依赖不进入 value 环检测（SCC-2/SCC-3 天然豁免）
		combinedDependencies: true,
	},
};
