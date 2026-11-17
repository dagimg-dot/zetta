// The in-browser demo's server. It runs zetta.wasm against demo.db in memory and answers the
// pages in its scope: the demo page gets the UI embedded in zetta.wasm, and every /api/ call
// goes through the same handlers the real server uses. Nothing leaves the browser.

/* global MemoryWasi */
importScripts("wasi.js");

const scope = new URL(self.registration.scope);
/** The cookie zetta.wasm expects; see `token` in src/wasm.zig. */
const cookie = "zetta_0=wasm";
const dsn = "file:/data/demo.db?immutable=1";

/** @type {Promise<(raw: Uint8Array) => Uint8Array> | undefined} */
let server;

function boot() {
	server ??= start().catch((err) => {
		server = undefined;
		throw err;
	});
	return server;
}

async function start() {
	const [wasm, db] = await Promise.all([
		fetch(new URL("zetta.wasm", scope)).then((r) => checked(r).arrayBuffer()),
		fetch(new URL("demo.db", scope)).then((r) => checked(r).arrayBuffer()),
	]);
	const wasi = new MemoryWasi({ "demo.db": new Uint8Array(db) });
	const { instance } = await WebAssembly.instantiate(wasm, wasi.imports());
	wasi.start(instance);
	const x = instance.exports;

	const put = (bytes) => {
		const ptr = x.zetta_alloc(bytes.length);
		if (!ptr) throw new Error("zetta.wasm is out of memory");
		new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
		return ptr;
	};
	const output = (len) => new Uint8Array(x.memory.buffer, x.zetta_output(), len).slice();

	const name = new TextEncoder().encode(dsn);
	const at = put(name);
	const opened = x.zetta_open(at, name.length);
	x.zetta_free(at, name.length);
	if (!opened) throw new Error(`zetta could not open the demo database: ${new TextDecoder().decode(output(200))}`);

	return (raw) => {
		const ptr = put(raw);
		const len = x.zetta_request(ptr, raw.length);
		x.zetta_free(ptr, raw.length);
		return output(len);
	};
}

function checked(res) {
	if (!res.ok) throw new Error(`${res.url} answered ${res.status}`);
	return res;
}

self.addEventListener("install", (event) => {
	event.waitUntil(boot().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

// The demo page asks for this after a hard reload, which leaves it uncontrolled.
self.addEventListener("message", (event) => {
	if (event.data === "claim") event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== scope.origin) return;
	if (url.pathname.startsWith("/api/")) {
		event.respondWith(answer(event.request, `${url.pathname}${url.search}`));
	} else if (event.request.mode === "navigate" && isDemoPage(url)) {
		event.respondWith(answer(new Request(url, { method: "GET" }), "/", true));
	}
});

function isDemoPage(url) {
	return url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
}

/** Turns a fetch into the raw HTTP/1.1 request zetta.wasm reads, and its answer back into a Response. */
async function answer(request, target, page = false) {
	try {
		const call = await boot();
		const body = new Uint8Array(await request.arrayBuffer());
		const type = request.headers.get("content-type");
		const head =
			`${request.method} ${target} HTTP/1.1\r\nhost: 127.0.0.1\r\ncookie: ${cookie}\r\n` +
			`content-length: ${body.length}\r\n${type ? `content-type: ${type}\r\n` : ""}` +
			`${page ? "accept-encoding: gzip\r\n" : ""}\r\n`;
		const raw = concat(new TextEncoder().encode(head), body);
		const res = call(raw);
		if (res.length === 0) return failure("zetta.wasm gave no answer");
		return toResponse(res);
	} catch (err) {
		return failure(err instanceof Error ? err.message : String(err));
	}
}

function failure(message) {
	return new Response(JSON.stringify({ error: "internal", message }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
}

function toResponse(bytes) {
	const split = indexOf(bytes, [13, 10, 13, 10]);
	const lines = new TextDecoder().decode(bytes.subarray(0, split)).split("\r\n");
	const [, code, ...reason] = (lines.shift() ?? "").split(" ");
	const status = Number(code);
	const headers = new Headers();
	let chunked = false;
	let gzip = false;
	for (const line of lines) {
		const colon = line.indexOf(":");
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (name === "transfer-encoding") chunked = value.toLowerCase().includes("chunked");
		else if (name === "content-encoding") gzip = value.toLowerCase() === "gzip";
		else if (!["content-length", "connection", "set-cookie", "keep-alive"].includes(name)) headers.append(name, value);
	}
	let body = bytes.subarray(split + 4);
	if (chunked) body = dechunk(body);
	const noBody = status === 204 || status === 304;
	const stream = gzip ? new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")) : body;
	return new Response(noBody ? null : stream, { status, statusText: reason.join(" "), headers });
}

function dechunk(body) {
	const parts = [];
	let at = 0;
	for (;;) {
		const eol = indexOf(body, [13, 10], at);
		const len = Number.parseInt(new TextDecoder().decode(body.subarray(at, eol)), 16);
		if (!len) break;
		parts.push(body.subarray(eol + 2, eol + 2 + len));
		at = eol + 2 + len + 2;
	}
	return concat(...parts);
}

function indexOf(bytes, needle, from = 0) {
	outer: for (let i = from; i <= bytes.length - needle.length; i++) {
		for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
		return i;
	}
	return bytes.length;
}

function concat(...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
