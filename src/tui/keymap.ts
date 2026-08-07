/**
 * Centralized keymap for pi-agents-flow's interactive panels.
 *
 * ## Why this exists
 *
 * The Fleet inspector and the Workflow Board each grew their own hardcoded key
 * checks (`data === "s"`, `data.toLowerCase() === "x"`, ...) plus a hand-written
 * hint string. Two consequences followed:
 *
 * 1. The panels drifted into conflicting meanings for the same key. `q` closed
 *    one panel but opened a quality report in the other, `x` expanded output in
 *    one and stopped a running node in the other, and `j`/`k` moved the
 *    selection in one while scrolling a detail pane in the other.
 * 2. The hint strings were literals, so they advertised keys that the handler
 *    would refuse. `s`/`D` are only meaningful for actionable async children, and
 *    `f` only in live view, yet every panel offered all three unconditionally.
 *
 * Both panels now describe one shared set of *actions*. Keys are declared once
 * here, so a conflict is a single-table edit rather than a cross-file discovery,
 * and the hint bar is generated from the same availability the handler uses —
 * a key that cannot fire is not advertised.
 *
 * ## Relationship to the host keybindings
 *
 * `@earendil-works/pi-tui` exposes a `KeybindingsManager`, but its `matches()`
 * only resolves ids present in the definitions it was constructed with, and the
 * extension API offers no hook to contribute definitions to the host manager.
 * So this table mirrors the host's shape (`defaultKeys` plus user overrides)
 * while resolving locally, and stays overridable through pi-agents-flow config.
 */
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

export type PiSwarmPanelAction =
	| "selectUp"
	| "selectDown"
	| "scrollUp"
	| "scrollDown"
	| "pageUp"
	| "pageDown"
	| "scrollStart"
	| "scrollEnd"
	| "toggleView"
	| "cycleView"
	| "confirm"
	| "close"
	| "follow"
	| "expandTools"
	| "refresh"
	| "steer"
	| "stop"
	| "quality"
	| "artifact";

export interface PiSwarmKeybindingDefinition {
	defaultKeys: KeyId[];
	/** Short label used in the panel hint bar, e.g. `jk node`. */
	hint: string;
	description: string;
}

/**
 * One table for both panels.
 *
 * Deliberate choices that resolve the previous cross-panel collisions:
 * - `q` closes everywhere. The Board's quality view moved to `Q`.
 * - `x` expands output everywhere. Stopping is `D` in both panels, so a
 *   destructive action never shares a key with a harmless one.
 * - `j`/`k` move the selection in both panels; detail scrolling is `J`/`K` and
 *   the page keys.
 */
export const PI_SWARM_PANEL_KEYBINDINGS: Record<PiSwarmPanelAction, PiSwarmKeybindingDefinition> = {
	selectUp: { defaultKeys: ["up", "k"], hint: "↑↓/jk", description: "Move selection up" },
	selectDown: { defaultKeys: ["down", "j"], hint: "↑↓/jk", description: "Move selection down" },
	scrollUp: { defaultKeys: ["shift+k"], hint: "JK scroll", description: "Scroll detail up" },
	scrollDown: { defaultKeys: ["shift+j"], hint: "JK scroll", description: "Scroll detail down" },
	pageUp: { defaultKeys: ["pageUp"], hint: "Pg", description: "Scroll detail one page up" },
	pageDown: { defaultKeys: ["pageDown"], hint: "Pg", description: "Scroll detail one page down" },
	scrollStart: { defaultKeys: ["home", "g"], hint: "g/G ends", description: "Jump to the start of the detail pane" },
	scrollEnd: { defaultKeys: ["end", "shift+g"], hint: "g/G ends", description: "Jump to the end of the detail pane" },
	toggleView: { defaultKeys: ["tab"], hint: "Tab focus", description: "Move focus between the roster and detail pane" },
	cycleView: { defaultKeys: ["v"], hint: "v view", description: "Cycle the current detail view" },
	confirm: { defaultKeys: ["return"], hint: "Enter", description: "Open the selected item" },
	close: { defaultKeys: ["escape", "ctrl+c", "q"], hint: "q/Esc", description: "Close the panel" },
	follow: { defaultKeys: ["f"], hint: "f follow", description: "Follow live output" },
	expandTools: { defaultKeys: ["x", "ctrl+o"], hint: "x tools", description: "Expand tool output" },
	refresh: { defaultKeys: ["r"], hint: "r refresh", description: "Reload durable state" },
	steer: { defaultKeys: ["s"], hint: "s steer", description: "Steer the selected child" },
	stop: { defaultKeys: ["shift+d"], hint: "D stop", description: "Stop the selected child or node" },
	quality: { defaultKeys: ["shift+q"], hint: "Q quality", description: "Show the quality report" },
	artifact: { defaultKeys: ["o"], hint: "o artifact", description: "Open the first artifact" },
};

/** User overrides, shaped like the host's `KeybindingsConfig`. */
export type PiSwarmKeymapOverrides = Partial<Record<PiSwarmPanelAction, KeyId | KeyId[] | undefined>>;

function normalizeKeys(keys: KeyId | KeyId[] | undefined, fallback: KeyId[]): KeyId[] {
	if (keys === undefined) return fallback;
	const list = Array.isArray(keys) ? keys : [keys];
	const filtered = list.filter((key) => typeof key === "string" && key.length > 0);
	return filtered.length > 0 ? filtered : fallback;
}

export interface PiSwarmKeymap {
	matches(data: string, action: PiSwarmPanelAction): boolean;
	keys(action: PiSwarmPanelAction): KeyId[];
	hint(action: PiSwarmPanelAction): string;
	/** Actions whose keys collide, so a bad override is visible rather than silent. */
	conflicts(): Array<{ key: KeyId; actions: PiSwarmPanelAction[] }>;
}

export function createPiSwarmKeymap(overrides: PiSwarmKeymapOverrides = {}): PiSwarmKeymap {
	const actions = Object.keys(PI_SWARM_PANEL_KEYBINDINGS) as PiSwarmPanelAction[];
	const resolved = new Map<PiSwarmPanelAction, KeyId[]>();
	for (const action of actions) {
		resolved.set(action, normalizeKeys(overrides[action], [...PI_SWARM_PANEL_KEYBINDINGS[action].defaultKeys]));
	}
	return {
		matches(data, action) {
			for (const key of resolved.get(action) ?? []) {
				if (matchesKey(data, key)) return true;
			}
			return false;
		},
		keys(action) {
			return [...(resolved.get(action) ?? [])];
		},
		hint(action) {
			return PI_SWARM_PANEL_KEYBINDINGS[action].hint;
		},
		conflicts() {
			const byKey = new Map<KeyId, PiSwarmPanelAction[]>();
			for (const action of actions) {
				for (const key of resolved.get(action) ?? []) {
					byKey.set(key, [...(byKey.get(key) ?? []), action]);
				}
			}
			// selectUp/selectDown and scrollStart/scrollEnd intentionally share a hint
			// but never a key; anything else sharing a key is a real conflict.
			return [...byKey.entries()]
				.filter(([, list]) => list.length > 1)
				.map(([key, list]) => ({ key, actions: list }));
		},
	};
}

/**
 * Build a hint bar from the actions that can actually fire right now.
 *
 * `available` reports whether an action is currently reachable. Unavailable
 * actions are omitted rather than shown, because advertising a key that the
 * handler will refuse is what made the old panels feel broken.
 */
export function panelHintBar(
	keymap: PiSwarmKeymap,
	order: PiSwarmPanelAction[],
	available: (action: PiSwarmPanelAction) => boolean,
	suffix?: string,
): string {
	const seen = new Set<string>();
	const hints: string[] = [];
	for (const action of order) {
		if (!available(action)) continue;
		const hint = keymap.hint(action);
		if (seen.has(hint)) continue;
		seen.add(hint);
		hints.push(hint);
	}
	return ` ${[...hints, ...(suffix ? [suffix] : [])].join(" · ")}`;
}
