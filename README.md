<p align="center"><img src="assets/icon.svg" width="96" height="96" alt="zetta"></p>

# zetta

A database explorer for Postgres and SQLite in a single binary under 3 MB. Point it at a database to browse and query it in your browser, or run SQL from the shell.

![Browsing the rows of a table](assets/screenshot-rows.png)

![The foreign keys around a table](assets/screenshot-relationships.png)

zetta is in early development.

## Features

- Browse every schema, table, view and function, and page through any table with filters and sorting
- Follow foreign keys from row to row, and see each table's structure, indexes, DDL and relationships
- Write SQL with highlighting and completion, with a prompt before anything that destroys data
- Every view lives in the URL, so a link opens the same table, filter or query
- `zetta query` and `zetta tables` for the shell, with table, CSV and JSON output
- Safe by default: listens on `127.0.0.1` with a fresh token each run, and `--read-only` is enforced in the database adapter
- One binary with the UI embedded, its own Postgres client with TLS, and SQLite compiled in

## Install

**Download a binary** from the [latest release](https://github.com/dagimg-dot/zetta/releases/latest) for macOS (Apple Silicon), Linux (x86_64, arm64) or Windows (x64, arm64), unpack it and put `zetta` on your `PATH`. On macOS, clear the download quarantine once with `xattr -d com.apple.quarantine zetta`.

**Run it with Docker** from [Docker Hub](https://hub.docker.com/r/workflowjd/zetta), as shown under [Docker](#docker).

**Build from source** with Zig 0.16.0 and bun:

```sh
cd web && bun install && cd ..
zig build -Doptimize=ReleaseSafe    # the binary is zig-out/bin/zetta
```

## Usage

```sh
zetta ./app.db                                    # browse a SQLite file
zetta postgres://me@localhost/app --read-only     # browse Postgres without writes
zetta query app.db 'select * from users limit 5'  # print a result
zetta query postgres://me@localhost/app -f csv < report.sql > report.csv
zetta tables app.db                               # list schemas and tables
```

`zetta` prints a URL with a one-time token and opens it in your browser, on port 1993 or the next free one. A database is a `postgres://` URL, a Postgres keyword string (`host=... dbname=...`), or a SQLite file. Set `DATABASE_URL` instead of passing it to keep a password out of the process list. Run `zetta --help` or `zetta <command> --help` for every option.

## Docker

```sh
export ZETTA_TOKEN=$(openssl rand -hex 16)

# Postgres
docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN \
  -e DATABASE_URL=postgres://user:password@db:5432/app workflowjd/zetta

# A SQLite file in the current directory
docker run --rm -p 127.0.0.1:1993:1993 -e ZETTA_TOKEN \
  --user "$(id -u):$(id -g)" -v "$PWD:/data" workflowjd/zetta serve /data/app.db
```

Then open `http://localhost:1993/?token=$ZETTA_TOKEN`. Inside the container zetta listens on all interfaces, so it needs `ZETTA_TOKEN` (16 to 64 letters and digits), and it serves plain HTTP, so keep the port on `127.0.0.1` unless a TLS proxy is in front. `--user` lets the container open a file you own.

The same image is on `ghcr.io/dagimg-dot/zetta`. The `latest` tag is the newest release and `edge` follows `main`.

## Postgres support

- URLs and keyword strings parsed as libpq does, `PG*` environment variables and `~/.pgpass`
- SCRAM-SHA-256, MD5, cleartext password and trust
- Every `sslmode` from `disable` to `verify-full`, TCP, IPv6 and Unix sockets
- Not supported: channel binding, client certificates, Kerberos, multiple hosts and `COPY FROM STDIN`

`--read-only` opens SQLite read-only. On Postgres it runs each statement in a read-only transaction and refuses `DO` and `CALL`. For a hard guarantee, connect as a read-only role.

## Development

```sh
zig build check                       # format check and full build
zig build test                        # unit tests and the adapter suite
ZETTA_TEST_PG_URL=postgres://... zig build test test-oracle -Dpg-oracle=true
cd web && bun run check               # types, lint and UI tests
cd web && bun run dev                 # UI dev server, proxies /api to zetta on port 1993
```

`dev/pg-matrix.sh` runs auth, TLS and sslmode against real servers in Docker.

## License

MIT. The binary also carries SQLite (public domain), solid-js and Ark UI (MIT), and the Lexend and Source Code Pro fonts (SIL Open Font License 1.1).
