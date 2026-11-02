# zetta

A small database explorer that runs as a single binary. Point it at a database and browse, filter and query it in your browser.

## Status

Early development. The current build supports Postgres and serves a one-page web UI. SQLite support, a Solid-based UI and a scriptable CLI are planned.

## Features

- Lists every schema, table and view, with approximate row counts
- Browses table data with a `WHERE` filter, `ORDER BY`, column sorting and paging
- Runs arbitrary SQL and shows the result in a grid
- Ships the UI embedded in the binary, with no runtime and no separate assets
- Binds to `127.0.0.1` and requires a per-run token

## Requirements

- Zig 0.16.0
- libpq (from your Postgres client package)

## Build

```sh
zig build -Doptimize=ReleaseSmall
```

The binary is written to `zig-out/bin/zetta`.

## Usage

```sh
DATABASE_URL='postgres://user:password@127.0.0.1:5432/mydb' zetta
```

```sh
zetta --url 'postgres://user:password@127.0.0.1:5432/mydb' --port 8080
```

On startup zetta prints a URL that contains a one-time token. Open it in your browser. The token is exchanged for a session cookie, and requests without it are refused.

| Option | Default | Description |
|---|---|---|
| `--url <dsn>` | `$DATABASE_URL` | Database connection string |
| `--host <addr>` | `127.0.0.1` | Address to listen on |
| `--port <port>` | `8080` | Port to listen on |

The SQL tab runs any statement with the privileges of the connecting role. To browse without risk, connect as a read-only role.

## Development

```sh
zig build check   # format check and full build
zig build test    # unit tests
```
