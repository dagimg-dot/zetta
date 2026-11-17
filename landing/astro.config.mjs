import { defineConfig } from "astro/config";

export default defineConfig({
	devToolbar: { enabled: false },
	vite: {
		// The screenshots are read from the repository's assets/ folder, one level up.
		server: { fs: { allow: [".."] } },
	},
});
