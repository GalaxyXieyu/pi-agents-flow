import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";

import { FleetAvatarRenderer } from "../../src/tui/fleet-avatar.ts";
import { fleetIdentity } from "../../src/tui/fleet-identity.ts";

describe("fleet identity", () => {
	it("assigns a stable name and compact pixel avatar per child key", () => {
		const first = fleetIdentity("run-a:0:researcher");
		assert.deepEqual(fleetIdentity("run-a:0:researcher"), first);
		assert.match(first.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
		assert.match(first.tone, /^(accent|success|warning|muted)$/);
		assert.ok(first.avatarIndex >= 0 && first.avatarIndex < 16);
		assert.match(first.avatarPath, /assets\/avatars\/\d{2}-[a-z-]+\.png$/);
		assert.equal(first.avatar.length, 7);
		assert.ok(first.avatar.every((line) => visibleWidth(line) === 11));
		assert.equal(visibleWidth(first.name), first.name.length);
	});

	it("varies identities across child keys", () => {
		const identities = Array.from({ length: 512 }, (_, index) => fleetIdentity(`run:${index}`));
		assert.ok(new Set(identities.map((identity) => identity.name)).size > 400);
		assert.equal(new Set(identities.map((identity) => identity.avatarPath)).size, 16);
		assert.ok(new Set(identities.map((identity) => identity.tone)).size >= 4);
	});

	it("falls back to the high-contrast terminal portrait when inline images are unavailable or missing", () => {
		const original = getCapabilities();
		try {
			const identity = fleetIdentity("run-a:0:researcher");
			const renderer = new FleetAvatarRenderer({ fg: (_color, value) => value });
			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			assert.deepEqual(renderer.render(identity), { lines: identity.avatar, width: 11 });
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const missing = renderer.render({ ...identity, avatarPath: "/missing/avatar.png" });
			assert.deepEqual(missing, { lines: identity.avatar, width: 11 });
		} finally {
			setCapabilities(original);
		}
	});

	it("localizes names without changing the stable avatar", () => {
		const english = fleetIdentity("run-a:0:researcher", "en");
		const chinese = fleetIdentity("run-a:0:researcher", "zh");
		assert.match(chinese.name, /^[\u4e00-\u9fff]+$/u);
		assert.equal(chinese.avatarPath, english.avatarPath);
		assert.equal(chinese.avatarIndex, english.avatarIndex);
	});
});
