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
    \\SQLite opens the file read-only. Postgres sets default_transaction_read_only,
    \\which a statement can still turn off; use a read-only role for a hard guarantee.
    ,
};
