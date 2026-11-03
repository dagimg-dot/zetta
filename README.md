# zetta

A small database explorer for Postgres and SQLite that runs as a single binary. Point it at a database to browse, filter and query it in your browser, or run SQL from the shell.

## Status

Early development. Postgres and SQLite work in both the web UI and the CLI. A Docker image is planned.

## Features

- A browser UI embedded in the binary, with no runtime and no separate assets
- Lists every schema, table and view, with approximate row counts on Postgres
- Shows column types and primary keys
- Browses tables with a `WHERE` filter, `ORDER BY`, column sorting, paging and collapsible columns
- Runs arbitrary SQL, with Ctrl+Enter in the UI or `zetta query` in the shell
- Prints results as an aligned table, CSV or JSON
- Has a read-only mode
- Binds to `127.0.0.1` by default and requires a per-run token
- Generates shell completions for bash, zsh and fish

## Requirements

- Zig 0.16.0
- libpq (from your Postgres client package)
- bun (to build the web UI)

SQLite is compiled in.

## Build

```sh
cd web && bun install && cd ..
zig build -Doptimize=ReleaseSmall
```

The binary is written to `zig-out/bin/zetta`. `zig build` runs `bun run build` in `web/` first. Pass `-Dui=prebuilt` to use an existing `web/dist/index.html` instead.

## Usage

```sh
zetta ./app.db
zetta serve postgres://me@localhost:5432/app --read-only
DATABASE_URL=postgres://me@localhost/app zetta
```

On startup zetta prints a URL that contains a one-time token. Open it in your browser. The token is exchanged for a session cookie, and requests without it are refused.

```sh
zetta query app.db 'select * from users limit 5'
zetta q postgres://me@localhost/app -f csv < report.sql > report.csv
zetta tables app.db
```

A database is given as `postgres://...`, a Postgres keyword string (`host=... dbname=...`), `sqlite:<path>`, or a path ending in `.db`, `.sqlite` or `.sqlite3`. zetta never creates a missing SQLite file. The database can also come from `ZETTA_DSN` or `DATABASE_URL`, which keeps a password out of the process list.

| Command | Description |
|---|---|
| `serve [DSN]` | Serve the web UI (the default command) |
| `query <DSN> [SQL]` | Run SQL and print the result. SQL is read from stdin when omitted |
| `tables <DSN>` | List schemas and tables |
| `completion <SHELL>` | Print a completion script for bash, zsh or fish |

Run `zetta <command> --help` for every option. Each option has an environment variable, and the precedence is command line, then environment, then default.

The SQL tab and `query` run any statement with the privileges of the connecting role. With Postgres, `--read-only` sets `default_transaction_read_only`, which a statement can turn off again. For a hard guarantee, connect as a read-only role.

## Shell completion

```sh
zetta completion bash > ~/.local/share/bash-completion/completions/zetta
zetta completion zsh > "${fpath[1]}/_zetta"
zetta completion fish > ~/.config/fish/completions/zetta.fish
```

## Development

```sh
zig build check   # format check and full build
zig build test    # unit tests and the adapter conformance suite
ZETTA_TEST_PG_URL=postgres://... zig build test   # also run the suite on Postgres
cd web && bun run dev   # UI dev server, proxies /api to zetta on port 7777
```
