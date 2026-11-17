const std = @import("std");
const cli = @import("cli");
const server = @import("server");
const common = @import("common.zig");
const Context = @import("Context.zig");

pub const Args = struct {
    dsn: ?[]const u8 = null,
    host: []const u8 = "127.0.0.1",
    port: ?u16 = null,
    token: ?[]const u8 = null,
    allow_plain_http: bool = false,
    allowed_hosts: ?[]const u8 = null,
    read_only: bool = false,
    statement_timeout: u32 = 30_000,
    wait: u32 = 0,
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
        \\Anything other than a loopback address needs --token and --allow-plain-http.
        },
        .{ .field = "port", .short = 'p', .env = &.{"ZETTA_PORT"}, .help =
        \\Port to listen on
        \\
        \\Without it zetta takes 1993, or the next free port when 1993 is taken. A port you
        \\choose is used as is: zetta stops if it is taken. 0 lets the system pick.
        },
        .{ .field = "token", .env = &.{"ZETTA_TOKEN"}, .help =
        \\Access token instead of a random one
        \\
        \\Useful in containers, where the URL is not visible. 16 to 64 letters, digits and
        \\- . _ ~, since it travels in a URL and a cookie; `openssl rand -hex 16` makes one.
        },
        .{ .field = "allow_plain_http", .env = &.{"ZETTA_ALLOW_PLAIN_HTTP"}, .help =
        \\Accept serving unencrypted on a non-loopback address
        \\
        \\zetta speaks only HTTP, so on a network the token, the session cookie and every row
        \\can be read in transit. Prefer an SSH tunnel to 127.0.0.1, or a TLS proxy in front.
        },
        .{ .field = "allowed_hosts", .value_name = "NAMES", .env = &.{"ZETTA_ALLOWED_HOSTS"}, .help =
        \\Host names to answer to, separated by commas
        \\
        \\IP addresses and localhost always work. Any other name is refused, which stops a
        \\web page from reaching zetta by repointing its own domain at this machine. List the
        \\name you use if zetta sits behind a proxy or has a DNS name of its own.
        },
        common.read_only,
        .{ .field = "statement_timeout", .value_name = "MS", .env = &.{"ZETTA_STATEMENT_TIMEOUT"}, .help =
        \\Stop a browse or a SQL tab query after this many milliseconds
        \\
        \\A query reads every row to count them, even past the 5,000 it returns, so this
        \\is what bounds a large one. 0 means no limit. Counting rows has its own 3 s budget.
        \\A query that times out can be run again from the SQL tab with up to ten times this,
        \\at most ten minutes.
        },
        .{ .field = "wait", .value_name = "SECONDS", .env = &.{"ZETTA_WAIT"}, .help =
        \\Keep trying to reach the database for this many seconds at startup
        \\
        \\For a database that starts alongside zetta, as in Docker Compose, and refuses
        \\connections for its first moments. 0 tries once. The Docker image sets 30.
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
    if (args.token) |given| {
        if (server.auth.tokenProblem(given)) |why| return ctx.usageError("the token {s}; `openssl rand -hex 16` makes one that works", .{why});
    }
    switch (exposure(args)) {
        .fine, .plain_http_accepted => {},
        .needs_token => return ctx.usageError("--host {s} is reachable from other machines; set --token (or ZETTA_TOKEN) as well", .{args.host}),
        .needs_plain_http_consent => return ctx.usageError("--host {s} would send the token and every row unencrypted, since zetta speaks only HTTP; use an SSH tunnel to 127.0.0.1, or set --allow-plain-http (or ZETTA_ALLOW_PLAIN_HTTP) to accept that", .{args.host}),
    }

    const adapter = switch (ctx.openDatabaseWaiting(args.dsn.?, .{ .read_only = args.read_only }, args.wait)) {
        .ok => |a| a,
        .exit => |code| return code,
    };
    defer adapter.deinit();

    const random = server.auth.randomToken(ctx.io);
    const token = args.token orelse &random;

    const wanted = args.port orelse default_port;
    var srv = server.Server.listen(ctx.io, adapter, .{
        .host = args.host,
        .port = wanted,
        .next_ports = if (args.port == null) next_ports else 0,
        .token = token,
        .allowed_hosts = args.allowed_hosts orelse "",
        .statement_timeout_ms = if (args.statement_timeout == 0) null else args.statement_timeout,
        .name = "zetta",
        .version = ctx.version,
    }) catch |err| return switch (err) {
        error.InvalidAddress => ctx.usageError("'{s}' is not an IP address", .{args.host}),
        error.AddressInUse => if (args.port == null)
            ctx.fail("ports {d} to {d} are all in use; pick one with --port", .{ wanted, wanted + next_ports })
        else
            ctx.fail("port {d} is already in use; pick another with --port, or leave it out to take a free one", .{wanted}),
        error.AddressUnavailable => ctx.usageError("{s} is not an address of this machine", .{args.host}),
        error.AccessDenied => ctx.fail("not allowed to listen on port {d}; ports below 1024 need privileges", .{wanted}),
        else => ctx.fail("cannot listen on {s}:{d}: {t}", .{ args.host, wanted, err }),
    };
    defer srv.deinit();
    const port = srv.port();

    const info = adapter.info();
    const url = try std.fmt.allocPrint(ctx.arena, "http://{s}:{d}/?token={s}", .{ try urlHost(ctx.arena, args.host), port, token });
    try ctx.stderr.print("zetta {s}: {t} database {s}{s}\n", .{ ctx.version, info.name, info.database, if (info.read_only) ", read-only" else "" });
    if (exposure(args) == .plain_http_accepted) try ctx.stderr.print("warning: serving plain HTTP on {s}: the token and every row cross the network unencrypted\n", .{args.host});
    if (port != wanted and wanted != 0) try ctx.stderr.print("port {d} is in use, so zetta took {d}\n", .{ wanted, port });
    if (isWildcard(args.host)) {
        for (try server.net.lanAddresses(ctx.arena)) |a| {
            try ctx.stderr.print("network: http://{d}.{d}.{d}.{d}:{d}/?token={s}\n", .{ a[0], a[1], a[2], a[3], port, token });
        }
    }
    try ctx.stderr.flush();
    try ctx.stdout.print("{s}\n", .{url});
    try ctx.stdout.flush();

    if (args.open orelse ctx.color_stdout) openBrowser(ctx, url);

    srv.run() catch |err| switch (err) {
        // Cancelled means the server was told to stop, which is how it ends.
        error.Canceled => {},
    };
    return .success;
}

/// The port zetta takes when none is given, and how many above it to try when it is taken.
const default_port = 1993;
const next_ports = 20;

const Exposure = enum { fine, needs_token, needs_plain_http_consent, plain_http_accepted };

/// Whether `args` may listen where they ask to, and what they gave up to do so.
fn exposure(args: Args) Exposure {
    if (server.auth.isLoopback(args.host)) return .fine;
    if (args.token == null) return .needs_token;
    return if (args.allow_plain_http) .plain_http_accepted else .needs_plain_http_consent;
}

fn isWildcard(host: []const u8) bool {
    return std.mem.eql(u8, host, "0.0.0.0") or std.mem.eql(u8, host, "::");
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
    if (isWildcard(host)) return "localhost";
    if (std.mem.indexOfScalar(u8, host, ':') != null) return std.fmt.allocPrint(arena, "[{s}]", .{host});
    return host;
}

test "loopback needs neither a token nor consent to plain HTTP" {
    try std.testing.expectEqual(.fine, exposure(.{}));
    try std.testing.expectEqual(.fine, exposure(.{ .host = "::1" }));
}

test "a network address needs a token first, then consent to plain HTTP" {
    try std.testing.expectEqual(.needs_token, exposure(.{ .host = "0.0.0.0" }));
    try std.testing.expectEqual(.needs_token, exposure(.{ .host = "0.0.0.0", .allow_plain_http = true }));
    try std.testing.expectEqual(.needs_plain_http_consent, exposure(.{ .host = "192.168.1.4", .token = "t" }));
    try std.testing.expectEqual(.plain_http_accepted, exposure(.{ .host = "192.168.1.4", .token = "t", .allow_plain_http = true }));
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
