import type { APIRoute } from "astro";
import { faq, installCmd, links, release } from "../site";

/** The site for language models, in the llms.txt format: https://llmstxt.org */
export const GET: APIRoute = ({ site }) => {
	const abs = (path: string) => new URL(path, site).href;
	const body = `# zetta

> A database explorer for Postgres and SQLite in one binary under 3 MB. Browse and query in your browser, or run SQL from the shell.

zetta is free and open source under the MIT license.${release ? ` The latest release is ${release}.` : ""} It serves its web UI from the binary to the browser you already have, on 127.0.0.1 with a one-time token. It speaks the Postgres wire protocol itself, with TLS, and compiles SQLite in, so it needs no libpq, OpenSSL or other client. Prebuilt binaries exist for macOS (Apple Silicon), Linux (x86_64, arm64) and Windows (x64, arm64), and the Docker image is workflowjd/zetta (also ghcr.io/dagimg-dot/zetta).

Quick start:

- Install on Linux or macOS: \`${installCmd}\`
- Browse a SQLite file: \`zetta ./app.db\`
- Browse Postgres without writes: \`zetta postgres://me@localhost/app --read-only\`
- Print a query result: \`zetta query app.db 'select * from users limit 5'\` (add \`-f csv\` or \`-f json\`)
- List schemas and tables: \`zetta tables app.db\`
- Run in Docker: \`docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN=$(openssl rand -hex 16) -e DATABASE_URL=postgres://user:password@host:5432/app workflowjd/zetta\`

zetta supports Postgres and SQLite only. It does not support MySQL, SQL Server or other databases.

## Docs

- [Full documentation](${abs("/llms-full.txt")}): install methods, usage, Docker and Docker Compose, Postgres authentication and TLS support, development
- [README](${links.repo}#readme): the same documentation on GitHub
- [Live demo](${abs("/demo/")}): zetta compiled to WebAssembly, running in the browser on a sample shop database, read-only

## Install

- [Latest release](${links.releases}): binaries for every platform with SHA256SUMS
- [Install script](https://raw.githubusercontent.com/dagimg-dot/zetta/main/install.sh): picks the build for the system and checks its checksum
- [Docker image](${links.docker}): a static binary on scratch for amd64 and arm64

## FAQ

${faq.map((f) => `- ${f.q} ${f.a}`).join("\n")}

## Optional

- [Source code](${links.repo}): Zig 0.16 for the binary, Solid and TypeScript for the UI
- [Issues](${links.issues}): bug reports and feature requests
- [License](${links.license}): MIT
`;
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
