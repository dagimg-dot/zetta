import { defineConfig, fontProviders } from "astro/config";

/**
 * Each family ships only its latin file; other scripts fall back to the system font. Astro
 * sizes a fallback face for each font its last fallback names, so that the swap moves nothing.
 * The "clone" families in global.css cover Linux, which has Arial's metric twins but not Arial.
 */
const latin = (file, weight, style = "normal") => ({
	src: [file],
	weight,
	style,
	unicodeRange: [
		"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
	],
});

export default defineConfig({
	site: "https://tryzetta.netlify.app",
	trailingSlash: "ignore",
	devToolbar: { enabled: false },
	// The page's CSS is small enough that a separate request costs more than it saves.
	build: { inlineStylesheets: "always" },
	fonts: [
		{
			provider: fontProviders.local(),
			name: "Lexend",
			cssVariable: "--font-lexend",
			fallbacks: ["Lexend clone", "system-ui"],
			options: {
				variants: [latin("@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2", "100 900")],
			},
		},
		{
			provider: fontProviders.local(),
			name: "Source Code Pro",
			cssVariable: "--font-code",
			fallbacks: ["Source Code Pro clone", "ui-monospace", "Menlo", "monospace"],
			options: {
				variants: [
					latin("@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2", "200 900"),
				],
			},
		},
		{
			provider: fontProviders.local(),
			name: "Instrument Serif",
			cssVariable: "--font-instrument",
			fallbacks: ["Instrument Serif clone", "Georgia", "serif"],
			options: {
				variants: [
					latin("@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2", 400, "italic"),
				],
			},
		},
	],
});
