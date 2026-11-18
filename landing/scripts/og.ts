// Renders the share card (public/og.png) from scripts/og.html and the touch icon
// (public/apple-touch-icon.png) from the favicon. Both are committed, so run this only when
// the card or the logo changes. Needs Chrome or Chromium; set CHROME to its path.
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const pub = join(root, "public");
const chrome =
	process.env.CHROME ??
	["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) {
	console.error("No Chrome or Chromium found. Set CHROME to its path.");
	process.exit(1);
}

const raw = join(pub, "og.raw.png");
const shot = Bun.spawnSync(
	[
		chrome,
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--allow-file-access-from-files",
		"--force-device-scale-factor=1",
		"--window-size=1200,630",
		"--virtual-time-budget=3000",
		`--screenshot=${raw}`,
		`file://${join(import.meta.dir, "og.html")}`,
	],
	{ stdout: "inherit", stderr: "ignore" },
);
if (shot.exitCode !== 0) process.exit(shot.exitCode ?? 1);

await sharp(raw).png({ palette: true, quality: 90, effort: 10 }).toFile(join(pub, "og.png"));
await Bun.file(raw).delete();

await sharp(join(pub, "favicon.svg"), { density: 300 })
	.resize(180, 180)
	.flatten({ background: "#EA580C" })
	.png()
	.toFile(join(pub, "apple-touch-icon.png"));

for (const name of ["og.png", "apple-touch-icon.png"]) {
	console.log(`public/${name}  ${(Bun.file(join(pub, name)).size / 1024).toFixed(0)} KB`);
}
