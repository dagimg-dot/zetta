import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, ".", "ZETTA_");
	// The zetta to proxy to; its session cookie is named after its port.
	const port = env.ZETTA_PORT || "1993";
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
					target: `http://127.0.0.1:${port}`,
					changeOrigin: true,
					// Host is rewritten to the target above, so Origin has to follow or zetta refuses the call.
					headers: {
						origin: `http://127.0.0.1:${port}`,
						...(env.ZETTA_TOKEN ? { cookie: `zetta_${port}=${env.ZETTA_TOKEN}` } : {}),
					},
				},
			},
		},
	};
});
