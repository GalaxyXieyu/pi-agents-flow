import * as fs from "node:fs";
import { getCapabilities, Image } from "@earendil-works/pi-tui";

import type { FleetIdentity } from "./fleet-identity.ts";

type AvatarTheme = {
	fg(color: "dim", value: string): string;
};

export interface FleetAvatarRender {
	lines: string[];
	width: number;
}

export class FleetAvatarRenderer {
	private readonly images = new Map<string, Image>();
	private readonly theme: AvatarTheme;

	constructor(theme: AvatarTheme) {
		this.theme = theme;
	}

	render(identity: FleetIdentity, maxWidthCells = 11, maxHeightCells = 7): FleetAvatarRender {
		if (!getCapabilities().images) return { lines: identity.avatar.map((line) => this.theme.fg("dim", line)), width: 11 };
		let image = this.images.get(identity.avatarPath);
		if (!image) {
			try {
				const base64 = fs.readFileSync(identity.avatarPath).toString("base64");
				image = new Image(base64, "image/png", {
					fallbackColor: (value) => this.theme.fg("dim", value),
				}, {
					maxWidthCells,
					maxHeightCells,
				});
				this.images.set(identity.avatarPath, image);
			} catch {
				return { lines: identity.avatar.map((line) => this.theme.fg("dim", line)), width: 11 };
			}
		}
		return { lines: image.render(maxWidthCells + 2), width: maxWidthCells };
	}

	invalidate(): void {
		for (const image of this.images.values()) image.invalidate();
	}
}
