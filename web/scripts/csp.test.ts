import { describe, expect, test } from "bun:test";
import { pageCsp } from "./csp";

const hashOf = (text: string) =>
	`'sha256-${new Bun.CryptoHasher("sha256").update(text).digest("base64")}'`;

const directive = (csp: string, name: string) =>
	csp.split("; ").find((d) => d.split(" ")[0] === name);

describe("the page's security policy", () => {
	const page = `<!doctype html><script>one()</script><style>a{}</style>
		<script type="module" crossorigin>two("</style>")</script><style rel="stylesheet">b{}</style>`;

	test("allows each inline script and style by its hash and nothing else", () => {
		const csp = pageCsp(page);
		expect(directive(csp, "script-src")).toBe(
			`script-src ${hashOf("one()")} ${hashOf('two("</style>")')}`,
		);
		expect(directive(csp, "style-src-elem")).toBe(
			`style-src-elem ${hashOf("a{}")} ${hashOf("b{}")}`,
		);
	});

	test("a script that appears only inside a comment is not allowed", () => {
		const csp = pageCsp("<!-- <script>nope()</script> --><script>yes()</script>");
		expect(directive(csp, "script-src")).toBe(`script-src ${hashOf("yes()")}`);
	});

	test("the same script twice is listed once", () => {
		const csp = pageCsp("<script>a()</script><script>a()</script>");
		expect(directive(csp, "script-src")).toBe(`script-src ${hashOf("a()")}`);
	});

	test("scripts can never be allowed wholesale", () => {
		const script = directive(pageCsp(page), "script-src") ?? "";
		expect(script).not.toContain("unsafe-inline");
		expect(script).not.toContain("unsafe-eval");
	});

	test("everything else is shut, and only zetta can be called", () => {
		const csp = pageCsp(page);
		expect(csp.startsWith("default-src 'none'; ")).toBe(true);
		expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
		expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
		expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
		expect(directive(csp, "form-action")).toBe("form-action 'none'");
	});

	test("a script loaded from a file fails the build, since the binary serves only the page", () => {
		expect(() => pageCsp('<script src="/app.js"></script>')).toThrow("inline everything");
	});
});
