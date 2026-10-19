/**
 * Renders assets/icon.svg into the PNG sizes of assets/icon.iconset, which
 * Electrobun turns into the macOS app icon. Runs on any OS, so a Linux CI
 * server can package the macOS app.
 */
import { mkdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const SOURCE = "assets/icon.svg";
const ICONSET = "assets/icon.iconset";

const svg = await Bun.file(SOURCE).text();
mkdirSync(ICONSET, { recursive: true });

for (const points of [16, 32, 128, 256, 512]) {
	for (const scale of [1, 2]) {
		const png = new Resvg(svg, { fitTo: { mode: "width", value: points * scale } }).render().asPng();
		const suffix = scale === 1 ? "" : "@2x";
		await Bun.write(`${ICONSET}/icon_${points}x${points}${suffix}.png`, png);
	}
}
