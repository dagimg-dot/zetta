import type { APIRoute } from "astro";
import readme from "../../../README.md?raw";
import { links, meta } from "../site";

/**
 * The repository README as plain Markdown, so the site's long-form docs for language models
 * never drift from the ones on GitHub. The README's centred HTML header becomes a title and
 * a summary, and its relative links point at the repository.
 */
export const GET: APIRoute = ({ site }) => {
	const start = readme.indexOf("\n## ");
	if (start < 0) throw new Error("README.md has no ## section to start llms-full.txt from");

	const body = readme
		.slice(start + 1)
		.replace(/<details>\s*<summary><strong>(.+?)<\/strong><\/summary>\s*(<br>\s*)?/g, "### $1\n\n")
		.replace(/<\/details>\s*/g, "")
		.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, `](${links.repo}/blob/main/$1)`);

	const head = `# zetta

> ${meta.description}

Website: ${new URL("/", site).href}
Live demo: ${new URL("/demo/", site).href}
Source: ${links.repo}

`;
	return new Response(head + body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
