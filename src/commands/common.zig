//! Options shared by several commands, declared once.

const cli = @import("cli");

pub const dsn: cli.Option = .{
    .field = "dsn",
    .positional = true,
    .required = true,
    .env = &.{ "ZETTA_DSN", "DATABASE_URL" },
    .help =
    \\Database to open: postgres://..., sqlite:<path>, or a .db/.sqlite file
    \\
    \\Postgres also accepts a keyword string such as "host=localhost dbname=app".
    \\SQLite files are never created; a missing file is an error.
    ,
};

pub const read_only: cli.Option = .{
    .field = "read_only",
    .env = &.{"ZETTA_READ_ONLY"},
    .help =
    \\Refuse writes
    \\
    \\SQLite opens the file read-only. Postgres runs caller SQL one statement at a time in
    \\read-only transactions, refuses DO and CALL, and resets the session after each request.
    \\Extensions such as dblink can still reach the server another way; use a read-only role
    \\for a hard guarantee.
    ,
};
