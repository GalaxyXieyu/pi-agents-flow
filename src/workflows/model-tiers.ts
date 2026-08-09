/**
 * Workflow model tier catalog.
 *
 * Pi's model registry has `reasoning` and `cost` metadata, but no tier tag.
 * `reasoning` alone is too coarse and `cost` is 0 for every taqu/codebuddy
 * model, so neither can auto-classify. This mapping is the authoritative
 * tier label the Supervisor sees in `workflow_assets` so it stops guessing
 * model names from training data.
 *
 * Only `enabledModels` entries are shown to the Supervisor; models not listed
 * here are omitted from the catalog rather than defaulted to a tier.
 */
export type ModelTier = "fast" | "standard" | "deep";

export interface ModelTierEntry {
	fullId: string;
	tier: ModelTier;
	note?: string;
}

/**
 * Provider-scoped tier mapping. Keys are `provider/model` (the same format as
 * `enabledModels` and `ModelInfo.fullId`). Update this map when models are
 * added, removed, or re-tiered in `models.json`.
 */
const MODEL_TIER_MAP: Record<string, ModelTierEntry> = {
	// ── taqu (primary, company gateway) ──────────────────────────────
	"taqu/deepseek-v4-flash": { fullId: "taqu/deepseek-v4-flash", tier: "fast", note: "DeepSeek V4 Flash" },
	"taqu//mnt/DeepSeek-V4-Flash": { fullId: "taqu//mnt/DeepSeek-V4-Flash", tier: "fast", note: "DeepSeek V4 Flash (本地部署)" },
	"taqu//mnt/Kimi-K2.6-INT8": { fullId: "taqu//mnt/Kimi-K2.6-INT8", tier: "fast", note: "Kimi K2.6 INT8 (本地部署)" },
	"taqu/glm-5.2-fast-preview": { fullId: "taqu/glm-5.2-fast-preview", tier: "fast", note: "GLM 5.2 Fast Preview" },
	"taqu/qwen3.6-flash": { fullId: "taqu/qwen3.6-flash", tier: "fast", note: "Qwen 3.6 Flash" },
	"taqu/qwen3.7-flash": { fullId: "taqu/qwen3.7-flash", tier: "fast", note: "Qwen 3.7 Flash" },
	"taqu/seed2.0-lite": { fullId: "taqu/seed2.0-lite", tier: "fast", note: "Seed 2.0 Lite" },
	"taqu/gpt-5.6-luna": { fullId: "taqu/gpt-5.6-luna", tier: "fast", note: "GPT-5.6 Luna (cheapest OpenAI tier)" },

	"taqu/kimi-k2.7-code": { fullId: "taqu/kimi-k2.7-code", tier: "standard", note: "Kimi K2.7 Code (coding-oriented)" },
	"taqu/glm-5.2": { fullId: "taqu/glm-5.2", tier: "standard", note: "GLM 5.2" },
	"taqu/qwen3.7-plus": { fullId: "taqu/qwen3.7-plus", tier: "standard", note: "Qwen 3.7 Plus" },

	"taqu/claude-opus-4.8": { fullId: "taqu/claude-opus-4.8", tier: "deep", note: "Claude Opus 4.8 (top reasoning)" },
	"taqu/qwen3.8-max": { fullId: "taqu/qwen3.8-max", tier: "deep", note: "Qwen 3.8 Max (flagship)" },
	"taqu/qwen3.7-max": { fullId: "taqu/qwen3.7-max", tier: "deep", note: "Qwen 3.7 Max" },

	// ── aigalaxy (commercial proxy, real pricing) ─────────────────────
	"aigalaxy/gpt-5.6-luna": { fullId: "aigalaxy/gpt-5.6-luna", tier: "fast", note: "GPT-5.6 Luna ($1/M in)" },
	"aigalaxy/gpt-5.6-terra": { fullId: "aigalaxy/gpt-5.6-terra", tier: "standard", note: "GPT-5.6 Terra ($2.5/M in)" },
	"aigalaxy/gpt-5.6-sol": { fullId: "aigalaxy/gpt-5.6-sol", tier: "deep", note: "GPT-5.6 Sol ($5/M in, top reasoning)" },
	"aigalaxy/grok-4.5": { fullId: "aigalaxy/grok-4.5", tier: "deep", note: "Grok 4.5 (500K context)" },

	// ── codebuddy (Tencent enterprise, free) ──────────────────────────
	"codebuddy/deepseek-v4-flash": { fullId: "codebuddy/deepseek-v4-flash", tier: "fast", note: "DeepSeek V4 Flash" },
	"codebuddy/glm-5v-turbo": { fullId: "codebuddy/glm-5v-turbo", tier: "fast", note: "GLM 5V Turbo" },
	"codebuddy/kimi-k2.6": { fullId: "codebuddy/kimi-k2.6", tier: "fast", note: "Kimi K2.6" },
	"codebuddy/hy3-preview-agent": { fullId: "codebuddy/hy3-preview-agent", tier: "fast", note: "HY3 Preview Agent" },

	"codebuddy/deepseek-v4-pro": { fullId: "codebuddy/deepseek-v4-pro", tier: "standard", note: "DeepSeek V4 Pro" },
	"codebuddy/glm-5.2": { fullId: "codebuddy/glm-5.2", tier: "standard", note: "GLM 5.2" },
	"codebuddy/glm-5.1": { fullId: "codebuddy/glm-5.1", tier: "standard", note: "GLM 5.1" },
	"codebuddy/kimi-k2.7": { fullId: "codebuddy/kimi-k2.7", tier: "standard", note: "Kimi K2.7" },
	"codebuddy/minimax-m3-pay": { fullId: "codebuddy/minimax-m3-pay", tier: "standard", note: "MiniMax M3" },

	"codebuddy/kimi-k3": { fullId: "codebuddy/kimi-k3", tier: "deep", note: "Kimi K3 (1M context, reasoning)" },
};

const TIER_ORDER: readonly ModelTier[] = ["fast", "standard", "deep"];

export const MODEL_TIER_DESCRIPTIONS: Record<ModelTier, string> = {
	fast: "Cheap and fast. Use for recon, lookups, mechanical edits, and simple well-scoped tasks.",
	standard: "Mid-tier. Use for routine multi-file edits, focused reviews, straightforward implementation, and most delegations.",
	deep: "Top reasoning. Use for hard analysis, architecture decisions, deep code audits, and tasks that arrive with explicit goals but require deep reasoning.",
};

/**
 * Resolve the tier for a model full id. Returns `undefined` for models not in
 * the mapping (unmapped models are intentionally excluded from the catalog
 * rather than guessed).
 */
export function resolveModelTier(fullId: string): ModelTierEntry | undefined {
	return MODEL_TIER_MAP[fullId];
}

/**
 * Group available model full ids by tier, preserving the mapping order.
 * Models not in the tier map are omitted so the Supervisor never sees an
 * unclassified model.
 */
export function groupModelsByTier(fullIds: readonly string[]): { tier: ModelTier; models: ModelTierEntry[] }[] {
	const byTier = new Map<ModelTier, ModelTierEntry[]>();
	for (const fullId of fullIds) {
		const entry = MODEL_TIER_MAP[fullId];
		if (!entry) continue;
		const list = byTier.get(entry.tier) ?? [];
		list.push(entry);
		byTier.set(entry.tier, list);
	}
	return TIER_ORDER
		.filter((tier) => byTier.has(tier))
		.map((tier) => ({ tier, models: byTier.get(tier)! }));
}

/**
 * Format the tier catalog for display in `workflow_assets`.
 *
 * Output is grouped by tier with a one-line description and model list:
 *
 * ```
 * Models (N) - omit agentSpec.model to inherit the current session model;
 * set agentSpec.model only when you need a specific tier
 *
 * fast — Cheap and fast. Use for recon, lookups, mechanical edits...
 * - taqu/deepseek-v4-flash - DeepSeek V4 Flash
 * ...
 *
 * standard — Mid-tier. Use for routine multi-file edits...
 * ...
 *
 * deep — Top reasoning. Use for hard analysis...
 * ...
 * ```
 */
export function formatModelTierCatalog(fullIds: readonly string[]): string {
	const groups = groupModelsByTier(fullIds);
	const total = groups.reduce((sum, group) => sum + group.models.length, 0);
	if (total === 0) return "Models (0) - (none enabled or mapped)";
	const lines = [
		`Models (${total}) - omit agentSpec.model to inherit the current session model; set it only when you need a specific tier`,
		"",
	];
	for (const group of groups) {
		lines.push(`${group.tier} — ${MODEL_TIER_DESCRIPTIONS[group.tier]}`);
		for (const model of group.models) {
			lines.push(`- ${model.fullId}${model.note ? ` - ${model.note}` : ""}`);
		}
		lines.push("");
	}
	// Drop trailing empty line.
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}
