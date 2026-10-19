/**
 * Renders the SVGs in assets/ into the icon files the build needs. Runs on any
 * OS, so a Linux CI server can package every platform.
 *
 * - assets/icon.iconset: PNG sizes Electrobun turns into the macOS app icon.
 * - assets/icon.ico: the Windows app icon (installer, shortcuts, taskbar).
 * - assets/icon.png: the Linux app icon (desktop entry, window, taskbar).
 * - assets/tray-*.ico: Windows tray icons; the Windows tray can't load SVGs.
 */
import { mkdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const ICONSET = "assets/icon.iconset";

const render = (svg: string, size: number) =>
	new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

/** An .ico holding one PNG-encoded image per size. */
const ico = (svg: string, sizes: ReadonlyArray<number>) => {
	const images = sizes.map((size) => ({ size, png: render(svg, size) }));
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, png }, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(size % 256, entry); // 0 means 256
		header.writeUInt8(size % 256, entry + 1);
		header.writeUInt16LE(1, entry + 4); // colour planes
		header.writeUInt16LE(32, entry + 6); // bits per pixel
		header.writeUInt32LE(png.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...images.map(({ png }) => png)]);
};

const appIcon = await Bun.file("assets/icon.svg").text();

mkdirSync(ICONSET, { recursive: true });
for (const points of [16, 32, 128, 256, 512]) {
	for (const scale of [1, 2]) {
		const suffix = scale === 1 ? "" : "@2x";
		await Bun.write(`${ICONSET}/icon_${points}x${points}${suffix}.png`, render(appIcon, points * scale));
	}
}

// Linux icon themes leave space around the shape too, like macOS.
await Bun.write("assets/icon.png", render(appIcon, 512));

// macOS draws its app icon inside transparent padding; Windows icons fill the
// square, so crop to the rounded tile.
const windowsAppIcon = appIcon.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
await Bun.write("assets/icon.ico", ico(windowsAppIcon, [16, 24, 32, 48, 64, 256]));

for (const state of ["paused", "sharing"]) {
	const tray = await Bun.file(`assets/tray-${state}.svg`).text();
	await Bun.write(`assets/tray-${state}.ico`, ico(tray, [16, 20, 24, 32, 40, 48]));
}
