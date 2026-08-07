import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PI_SWARM_PANEL_KEYBINDINGS, createPiSwarmKeymap, panelHintBar, type PiSwarmPanelAction } from "../../src/tui/keymap.ts";

describe("pi-agents-flow panel keymap", () => {
	it("resolves the documented defaults", () => {
		const keymap = createPiSwarmKeymap();
		assert.equal(keymap.matches("\x1b[A", "selectUp"), true);
		assert.equal(keymap.matches("k", "selectUp"), true);
		assert.equal(keymap.matches("\x1b[B", "selectDown"), true);
		assert.equal(keymap.matches("j", "selectDown"), true);
		assert.equal(keymap.matches("K", "scrollUp"), true);
		assert.equal(keymap.matches("J", "scrollDown"), true);
		assert.equal(keymap.matches("\t", "toggleView"), true);
		assert.equal(keymap.matches("v", "cycleView"), true);
		assert.equal(keymap.matches("f", "follow"), true);
		assert.equal(keymap.matches("x", "expandTools"), true);
		assert.equal(keymap.matches("r", "refresh"), true);
		assert.equal(keymap.matches("s", "steer"), true);
		assert.equal(keymap.matches("D", "stop"), true);
		assert.equal(keymap.matches("Q", "quality"), true);
		assert.equal(keymap.matches("o", "artifact"), true);
		assert.equal(keymap.matches("q", "close"), true);
		assert.equal(keymap.matches("\x1b", "close"), true);
	});

	it("keeps the previously colliding keys unambiguous", () => {
		const keymap = createPiSwarmKeymap();
		// q used to close the Fleet inspector but open the Board's quality report.
		assert.equal(keymap.matches("q", "close"), true);
		assert.equal(keymap.matches("q", "quality"), false);
		// x used to expand output in one panel and stop a running node in the other.
		assert.equal(keymap.matches("x", "expandTools"), true);
		assert.equal(keymap.matches("x", "stop"), false);
		assert.equal(keymap.matches("D", "stop"), true);
		// j/k moved the selection in one panel and scrolled the detail in the other.
		assert.equal(keymap.matches("j", "selectDown"), true);
		assert.equal(keymap.matches("j", "scrollDown"), false);
	});

	it("reports no conflicts in the shipped defaults", () => {
		assert.deepEqual(createPiSwarmKeymap().conflicts(), []);
	});

	it("applies user overrides and surfaces a conflict they introduce", () => {
		const keymap = createPiSwarmKeymap({ stop: "ctrl+alt+x", steer: ["s", "shift+s"] });
		assert.equal(keymap.matches("D", "stop"), false);
		assert.equal(keymap.matches("S", "steer"), true);

		const clashing = createPiSwarmKeymap({ stop: "x" });
		const conflicts = clashing.conflicts();
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0]?.key, "x");
		assert.deepEqual([...(conflicts[0]?.actions ?? [])].sort(), ["expandTools", "stop"]);
	});

	it("falls back to defaults for an empty or malformed override", () => {
		const keymap = createPiSwarmKeymap({ stop: [] });
		assert.equal(keymap.matches("D", "stop"), true);
	});

	it("omits unavailable actions from the hint bar", () => {
		const keymap = createPiSwarmKeymap();
		const order: PiSwarmPanelAction[] = ["selectUp", "toggleView", "follow", "steer", "stop", "close"];
		const all = panelHintBar(keymap, order, () => true, "2/3");
		assert.equal(all, " ↑↓/jk · Tab focus · f follow · s steer · D stop · q/Esc · 2/3");

		// A foreground workflow child can never be steered or stopped from Fleet, so
		// those hints must not be advertised there.
		const limited = panelHintBar(keymap, order, (action) => action !== "steer" && action !== "stop", "2/3");
		assert.equal(limited, " ↑↓/jk · Tab focus · f follow · q/Esc · 2/3");
		assert.doesNotMatch(limited, /steer|stop/);
	});

	it("collapses actions that intentionally share one hint", () => {
		const keymap = createPiSwarmKeymap();
		const bar = panelHintBar(keymap, ["selectUp", "selectDown", "scrollStart", "scrollEnd"], () => true);
		assert.equal(bar, " ↑↓/jk · g/G ends");
	});

	it("describes every action so the table stays self-documenting", () => {
		for (const [action, definition] of Object.entries(PI_SWARM_PANEL_KEYBINDINGS)) {
			assert.ok(definition.defaultKeys.length > 0, `${action} needs a default key`);
			assert.ok(definition.hint.length > 0, `${action} needs a hint`);
			assert.ok(definition.description.length > 0, `${action} needs a description`);
		}
	});
});
