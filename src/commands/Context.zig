//! What every command gets from main: allocators, io, the environment and
//! the two output streams. Results go to stdout, everything else to stderr.

const std = @import("std");
const cli = @import("cli");
const db = @import("db");

const Context = @This();

gpa: std.mem.Allocator,
/// Lives until the process exits.
arena: std.mem.Allocator,
io: std.Io,
env: *const std.process.Environ.Map,
stdout: *std.Io.Writer,
stderr: *std.Io.Writer,
/// Whether stdout is a terminal that takes color.
color_stdout: bool,
version: []const u8,

pub fn fail(ctx: *Context, comptime fmt: []const u8, args: anytype) cli.ExitCode {
    ctx.printError(fmt, args);
    return .failure;
}

pub fn usageError(ctx: *Context, comptime fmt: []const u8, args: anytype) cli.ExitCode {
    ctx.printError(fmt, args);
    return .usage;
}

fn printError(ctx: *Context, comptime fmt: []const u8, args: anytype) void {
    ctx.stderr.print("error: " ++ fmt ++ "\n", args) catch {};
    ctx.stderr.flush() catch {};
}

/// Parses the DSN and opens the adapter, reporting any failure. The caller
/// owns the adapter.
pub fn openDatabase(ctx: *Context, text: []const u8, options: db.OpenOptions) union(enum) { ok: db.Adapter, exit: cli.ExitCode } {
    const dsn = db.dsn.parse(ctx.arena, text) catch |err| return .{ .exit = switch (err) {
        error.OutOfMemory => ctx.fail("out of memory", .{}),
        error.Empty => ctx.usageError("the database is empty", .{}),
        error.UnknownScheme => ctx.usageError(
            "cannot tell which database '{s}' is; use postgres://..., sqlite:<path> or a .db/.sqlite file",
            .{text},
        ),
    } };
    var diag: db.Diagnostic = .{};
    var with_env = options;
    with_env.env = ctx.env;
    const adapter = db.open(ctx.gpa, ctx.io, dsn, with_env, &diag) catch |err| {
        var buf: [512]u8 = undefined;
        var w: std.Io.Writer = .fixed(&buf);
        db.dsn.redact(text, &w) catch {};
        return .{ .exit = ctx.fail("cannot open {s}: {s}", .{ w.buffered(), if (diag.message().len > 0) diag.message() else @errorName(err) }) };
    };
    return .{ .ok = adapter };
}
