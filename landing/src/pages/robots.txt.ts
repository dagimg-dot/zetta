import type { APIRoute } from "astro";

/** Search engines and AI assistants are all welcome; the explicit groups say so to the ones that look for their own name. */
const aiAgents = [
	"GPTBot",
	"OAI-SearchBot",
	"ChatGPT-User",
	"ClaudeBot",
	"Claude-SearchBot",
	"Claude-User",
	"PerplexityBot",
	"Perplexity-User",
	"Google-Extended",
	"Applebot-Extended",
	"CCBot",
];

export const GET: APIRoute = ({ site }) => {
	const body = [
		"User-agent: *",
		"Allow: /",
		"",
		...aiAgents.map((a) => `User-agent: ${a}`),
		"Allow: /",
		"",
		`Sitemap: ${new URL("/sitemap.xml", site).href}`,
		"",
	].join("\n");
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
