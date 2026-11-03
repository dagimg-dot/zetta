const std = @import("std");
const cli = @import("cli");
const server = @import("server");
const common = @import("common.zig");
const Context = @import("Context.zig");

pub const Args = struct {
    dsn: ?[]const u8 = null,
    host: []const u8 = "127.0.0.1",
    port: u16 = 7777,
    token: ?[]const u8 = null,
    read_only: bool = false,
    statement_timeout: u32 = 30_000,
    open: ?bool = null,

    pub const about =
        \\Serve the web UI
        \\
        \\Opens the database, prints a URL with a one-time token, and serves the UI
        \\and the JSON API until stopped. The token is traded for a session cookie
        \\the first time the URL is opened.
    ;
    pub const options = [_]cli.Option{
        common.dsn,
        .{ .field = "host", .short = 'H', .value_name = "ADDR", .env = &.{"ZETTA_HOST"}, .help =
        \\Address to listen on
        \\
        \\Anything other than a loopback address needs --token.
        },
        .{ .field = "port", .short = 'p', .env = &.{"ZETTA_PORT"}, .help = "Port to listen on" },
        .{ .field = "token", .env = &.{"ZETTA_TOKEN"}, .help =
        \\Access token instead of a random one
        \\
        \\Useful in containers, where the URL is not visible.
        },
        common.read_only,
        .{ .field = "statement_timeout", .value_name = "MS", .env = &.{"ZETTA_STATEMENT_TIMEOUT"}, .help =
        \\Stop a browse or a SQL tab query after this many milliseconds
        \\
        \\A query reads every row to count them, even past the 5,000 it returns, so this
        \\is what bounds a large one. 0 means no limit. Counting rows has its own 3 s budget.
        },
        .{ .field = "open", .negatable = true, .help = "Open the UI in a browser (default: when stdout is a terminal)" },
    };
    pub const examples = [_]cli.Example{
        .{ .command = "zetta ./app.db", .help = "Browse a SQLite file" },
        .{ .command = "zetta serve postgres://me@localhost/app --read-only", .help = "Browse Postgres without writes" },
        .{ .command = "DATABASE_URL=postgres://me@localhost/app zetta", .help = "Take the database from the environment" },
    };
};

pub fn run(ctx: *Context, args: Args) !cli.ExitCode {
    if (!server.auth.isLoopback(args.host) and args.token == null) {
        return ctx.usageError("--host {s} is reachable from other machines; set --token (or ZETTA_TOKEN) as well", .{args.host});
    }

    const adapter = switch (ctx.openDatabase(args.dsn.?, .{ .read_only = args.read_only })) {
        .ok => |a| a,
        .exit => |code| return code,
    };
    defer adapter.deinit();

    const random = server.auth.randomToken(ctx.io);
    const token = args.token orelse &random;

    var srv = server.Server.listen(ctx.io, adapter, .{
        .host = args.host,
        .port = args.port,
        .token = token,
        .statement_timeout_ms = if (args.statement_timeout == 0) null else args.statement_timeout,
        .name = "zetta",
        .version = ctx.version,
    }) catch |err| return switch (err) {
        error.InvalidAddress => ctx.usageError("'{s}' is not an IP address", .{args.host}),
        error.AddressInUse => ctx.fail("port {d} is already in use; pick another with --port", .{args.port}),
        else => ctx.fail("cannot listen on {s}:{d}: {t}", .{ args.host, args.port, err }),
    };
    defer srv.deinit();

    const info = adapter.info();
    const url = try std.fmt.allocPrint(ctx.arena, "http://{s}:{d}/?token={s}", .{ try urlHost(ctx.arena, args.host), args.port, token });
    try ctx.stderr.print("zetta {s}: {t} database {s}{s}\n", .{ ctx.version, info.name, info.database, if (info.read_only) ", read-only" else "" });
    try ctx.stderr.flush();
    try ctx.stdout.print("{s}\n", .{url});
    try ctx.stdout.flush();

    if (args.open orelse ctx.color_stdout) openBrowser(ctx, url);

    srv.run() catch {};
    return .success;
}

fn openBrowser(ctx: *Context, url: []const u8) void {
    const argv: []const []const u8 = switch (@import("builtin").os.tag) {
        .macos => &.{ "open", url },
        .windows => &.{ "rundll32", "url.dll,FileProtocolHandler", url },
        else => &.{ "xdg-open", url },
    };
    const opener = argv[0];
    var child = std.process.spawn(ctx.io, .{
        .argv = argv,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    }) catch |err| {
        std.log.scoped(.serve).info("could not run {s}: {t}", .{ opener, err });
        return;
    };
    _ = child.wait(ctx.io) catch {};
}

/// The host to print in the startup URL. A wildcard bind is not an address anyone can open,
/// so it prints as localhost; an IPv6 literal needs brackets.
fn urlHost(arena: std.mem.Allocator, host: []const u8) ![]const u8 {
    if (std.mem.eql(u8, host, "0.0.0.0") or std.mem.eql(u8, host, "::")) return "localhost";
    if (std.mem.indexOfScalar(u8, host, ':') != null) return std.fmt.allocPrint(arena, "[{s}]", .{host});
    return host;
}

test "wildcard binds print as localhost and IPv6 gets brackets" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    try std.testing.expectEqualStrings("localhost", try urlHost(arena, "0.0.0.0"));
    try std.testing.expectEqualStrings("localhost", try urlHost(arena, "::"));
    try std.testing.expectEqualStrings("[fe80::1]", try urlHost(arena, "fe80::1"));
    try std.testing.expectEqualStrings("127.0.0.1", try urlHost(arena, "127.0.0.1"));
}
