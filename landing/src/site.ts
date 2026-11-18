export const links = {
	repo: "https://github.com/dagimg-dot/zetta",
	releases: "https://github.com/dagimg-dot/zetta/releases/latest",
	docker: "https://hub.docker.com/r/workflowjd/zetta",
	license: "https://github.com/dagimg-dot/zetta/blob/main/LICENSE",
	issues: "https://github.com/dagimg-dot/zetta/issues",
};

export const meta = {
	name: "zetta",
	title: "zetta · Postgres and SQLite explorer in your browser",
	description:
		"Free, open-source database explorer for Postgres and SQLite. Browse and query in your browser or from the shell. One binary under 3 MB, or one docker run.",
	ogImage: "/og.png",
	ogImageAlt: "zetta: your database, in a browser tab. Postgres and SQLite in one binary under 3 MB.",
};

/**
 * The latest release tag, read once at build time so the page, its structured data and
 * llms.txt carry it without a request. Version.astro refreshes it in the browser. Null when
 * GitHub cannot be reached, and then nothing shows a version.
 */
export const release: string | null = await (async () => {
	try {
		const res = await fetch("https://api.github.com/repos/dagimg-dot/zetta/releases/latest", {
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			console.warn(`[site] latest release: GitHub answered ${res.status}`);
			return null;
		}
		const body = (await res.json()) as { tag_name?: unknown };
		return typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
	} catch (err) {
		console.warn(`[site] latest release: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
})();

/** Shown in the FAQ section and given to search engines as FAQPage data, so keep them identical. */
export const faq = [
	{
		q: "What is zetta?",
		a: "zetta is a free, open-source database explorer for Postgres and SQLite. It is one binary under 3 MB that serves its UI to the browser you already have, so you can browse schemas, filter tables, follow foreign keys and run SQL. The same binary also runs queries from the shell.",
	},
	{
		q: "Which databases does zetta support?",
		a: "Postgres and SQLite. zetta speaks the Postgres wire protocol itself, with SCRAM-SHA-256, MD5 and every sslmode, and compiles the official SQLite amalgamation in. A database is a postgres:// URL, a libpq keyword string or a path to a SQLite file.",
	},
	{
		q: "Do I need libpq, OpenSSL or a database client installed?",
		a: "No. The binary links libc and nothing else. Its Postgres client and TLS are written in Zig, SQLite is compiled in, and the web UI is embedded. There are prebuilt binaries for macOS, Linux and Windows, and a 1.5 MB Docker image.",
	},
	{
		q: "Is it safe to point zetta at a real database?",
		a: "zetta listens on 127.0.0.1 with a new one-time token each run, and refuses other hosts and origins. With --read-only it refuses writes inside the database adapter, not just in the UI, and passwords never reach a log. For a hard guarantee on Postgres, connect as a read-only role.",
	},
	{
		q: "How is zetta different from a desktop database client?",
		a: "There is nothing to install beyond one small binary or one docker run, and every view lives in the URL, so a link opens the same table, filter and row for someone else. It also fits in a docker-compose.yml beside the database your project already runs.",
	},
	{
		q: "Can I use zetta from scripts and CI?",
		a: "Yes. zetta query prints a table, CSV or JSON to stdout with diagnostics on stderr, and zetta tables lists schemas and tables. Every flag has an environment variable, and DATABASE_URL keeps a password out of the process list.",
	},
	{
		q: "Is zetta free?",
		a: "Yes. zetta is open source under the MIT license, and the live demo on this site runs it in your browser with nothing to install.",
	},
];

export const installCmd =
	"curl -fsSL https://raw.githubusercontent.com/dagimg-dot/zetta/main/install.sh | sh";

/** The compose file the Compose section shows, as the copy button copies it. */
export const composeYaml = `services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres

  zetta:
    image: workflowjd/zetta
    ports: ["127.0.0.1:1993:1993"]
    environment:
      ZETTA_TOKEN: \${ZETTA_TOKEN}
      DATABASE_URL: postgres://postgres:postgres@db:5432/postgres
    depends_on: [db]
`;

/**
 * One line, so pasting it does not run it before the URL is edited. Inside the
 * container zetta needs a token; it prints a localhost link that carries it.
 */
export const dockerCmd =
	"docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN=$(openssl rand -hex 16) -e DATABASE_URL=postgres://user:password@host:5432/app workflowjd/zetta";
