import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, ".", "ZETTA_");
	return {
		plugins: [solid(), viteSingleFile()],
		build: {
			target: "es2022",
			assetsInlineLimit: Number.MAX_SAFE_INTEGER,
			cssCodeSplit: false,
		},
		server: {
			proxy: {
				"/api": {
					target: "http://127.0.0.1:7777",
					changeOrigin: true,
					headers: env.ZETTA_TOKEN ? { cookie: `zetta=${env.ZETTA_TOKEN}` } : {},
				},
			},
		},
	};
});
