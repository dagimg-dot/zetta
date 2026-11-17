// Builds what the in-browser demo serves from public/demo/: zetta.wasm from the repository,
// and demo.db from dev/seed.sql. Needs Zig 0.16.0; set ZIG when `zig` is another version.
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const out = join(import.meta.dir, "..", "public", "demo");
const zig = process.env.ZIG ?? "zig";

const version = Bun.spawnSync([zig, "version"]).stdout.toString().trim();
if (version !== "0.16.0") {
	console.error(`zetta needs Zig 0.16.0, but ${zig} is ${version || "missing"}. Set ZIG to a 0.16.0 binary.`);
	process.exit(1);
}

const build = Bun.spawnSync([zig, "build", "wasm"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

mkdirSync(out, { recursive: true });
copyFileSync(join(root, "zig-out", "wasm", "zetta.wasm"), join(out, "zetta.wasm"));

const dbPath = join(out, "demo.db");
rmSync(dbPath, { force: true });
const db = new Database(dbPath, { create: true });
db.exec(await Bun.file(join(root, "dev", "seed.sql")).text());
db.exec("vacuum");
db.close();

for (const name of ["zetta.wasm", "demo.db"]) {
	const size = Bun.file(join(out, name)).size;
	console.log(`demo/${name}  ${(size / 1024).toFixed(0)} KB`);
}
