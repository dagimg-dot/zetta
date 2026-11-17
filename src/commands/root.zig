//! zetta's command line, declared once. Parsing, help, completions and
//! `zetta __spec` all come from this declaration.

const cli = @import("cli");

pub const Context = @import("Context.zig");
const serve = @import("serve.zig");
const query = @import("query.zig");
const tables = @import("tables.zig");

pub const Color = enum { auto, always, never };

pub const Cli = struct {
    verbose: u8 = 0,
    quiet: bool = false,
    color: Color = .auto,
    command: Command = undefined,

    pub const name = "zetta";
    pub const about =
        \\A small database explorer for Postgres and SQLite
        \\
        \\Serves a browser UI for a database, or runs SQL from the shell.
    ;
    pub const default_command = "serve";
    pub const Command = union(enum) {
        serve: serve.Args,
        query: query.Args,
        tables: tables.Args,
    };
    pub const options = [_]cli.Option{
        .{ .field = "verbose", .short = 'v', .count = true, .global = true, .help = "More logging (-v requests, -vv debug)" },
        .{ .field = "quiet", .short = 'q', .global = true, .conflicts = &.{"verbose"}, .help = "Only log errors" },
        .{ .field = "color", .global = true, .value_name = "WHEN", .env = &.{"ZETTA_COLOR"}, .help = "When to use color (NO_COLOR is also honoured)" },
    };
};

pub fn run(ctx: *Context, command: Cli.Command) !cli.ExitCode {
    return switch (command) {
        .serve => |args| serve.run(ctx, args),
        .query => |args| query.run(ctx, args),
        .tables => |args| tables.run(ctx, args),
    };
}

test {
    _ = @import("serve.zig");
}
