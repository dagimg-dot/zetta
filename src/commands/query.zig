const std = @import("std");
const cli = @import("cli");
const db = @import("db");
const render = @import("render");
const common = @import("common.zig");
const Context = @import("Context.zig");

pub const Format = enum { table, json, csv };

pub const Args = struct {
    dsn: ?[]const u8 = null,
    sql: ?[]const u8 = null,
    format: Format = .table,
    read_only: bool = false,
    max_rows: u32 = 10_000,

    pub const about =
        \\Run SQL and print the result
        \\
        \\Several statements may be given; the result of the last one is printed.
        \\Without SQL, or with "-", the SQL is read from stdin.
    ;
    pub const aliases = [_][]const u8{"q"};
    pub const options = [_]cli.Option{
        common.dsn,
        .{ .field = "sql", .positional = true, .help = "SQL to run (default: read stdin)" },
        .{ .field = "format", .short = 'f', .env = &.{"ZETTA_FORMAT"}, .help = "Output format" },
        common.read_only,
        .{ .field = "max_rows", .short = 'n', .value_name = "N", .help = "Print at most N rows" },
    };
    pub const examples = [_]cli.Example{
        .{ .command = "zetta query app.db 'select * from users limit 5'" },
        .{ .command = "zetta q postgres://me@localhost/app -f csv < report.sql > report.csv" },
    };
};

pub fn run(ctx: *Context, args: Args) !cli.ExitCode {
    const sql = if (args.sql) |s| (if (std.mem.eql(u8, s, "-")) try readStdin(ctx) else s) else try readStdin(ctx);
    if (std.mem.trim(u8, sql, " \t\r\n").len == 0) return ctx.usageError("no SQL given", .{});

    const adapter = switch (ctx.openDatabase(args.dsn.?, .{ .read_only = args.read_only, .pool_size = 1 })) {
        .ok => |a| a,
        .exit => |code| return code,
    };
    defer adapter.deinit();

    var diag: db.Diagnostic = .{};
    const rs = adapter.query(ctx.arena, sql, .{ .max_rows = args.max_rows }, &diag) catch |err|
        return ctx.fail("{s}", .{if (diag.message().len > 0) diag.message() else @errorName(err)});

    switch (args.format) {
        .table => try render.text.table(ctx.stdout, rs, .{ .color = ctx.color_stdout }),
        .csv => try render.text.csv(ctx.stdout, rs),
        .json => {
            try render.json.resultSet(ctx.stdout, rs, null);
            try ctx.stdout.writeByte('\n');
        },
    }
    return .success;
}

fn readStdin(ctx: *Context) ![]const u8 {
    var buf: [4096]u8 = undefined;
    var reader = std.Io.File.stdin().reader(ctx.io, &buf);
    return reader.interface.allocRemaining(ctx.arena, .limited(64 << 20));
}
