//! One function per route in docs/API.md. Each gets a fresh arena; nothing
//! here knows which database is behind the adapter.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Request = std.http.Server.Request;
const db = @import("db");
const render = @import("render");
const http = @import("http.zig");
const auth = @import("auth.zig");
const guard = @import("guard.zig");
const qparam = @import("q.zig");

/// The UI page, gzipped at build time. Every browser accepts gzip, so it is never inflated here.
const ui_index_gz = @embedFile("ui_index");
/// The policy for that exact page, which allows its inline code by hash. Built alongside it.
const ui_csp = @embedFile("ui_csp");

pub const Context = struct {
    io: std.Io,
    adapter: db.Adapter,
    token: []const u8,
    /// Host names to answer to beyond IP addresses and localhost, separated by commas.
    allowed_hosts: []const u8 = "",
    /// Names the session cookie, since browsers share cookies across the ports of one host.
    port: u16 = 0,
    statement_timeout_ms: ?u32 = null,
    name: []const u8,
    version: []const u8,
};

const Route = enum { index, meta, catalog, columns, table, function, count, compile, browse, query, not_found };

fn route(method: std.http.Method, path: []const u8) Route {
    const eql = std.mem.eql;
    if (method == .GET and (eql(u8, path, "/") or eql(u8, path, "/index.html"))) return .index;
    if (method == .GET and eql(u8, path, "/api/meta")) return .meta;
    if (method == .GET and eql(u8, path, "/api/catalog")) return .catalog;
    if (method == .GET and eql(u8, path, "/api/columns")) return .columns;
    if (method == .GET and eql(u8, path, "/api/table")) return .table;
    if (method == .GET and eql(u8, path, "/api/function")) return .function;
    if (method == .GET and eql(u8, path, "/api/count")) return .count;
    if (method == .GET and eql(u8, path, "/api/compile")) return .compile;
    if (method == .GET and eql(u8, path, "/api/browse")) return .browse;
    if (method == .POST and eql(u8, path, "/api/query")) return .query;
    return .not_found;
}

/// Returns the status sent, for the access log.
pub fn handle(ctx: *const Context, arena: Allocator, req: *Request) !std.http.Status {
    const target = http.Target.parse(req.head.target);
    if (guard.refusal(req, ctx.allowed_hosts, target.path)) |no| return fail(req, .forbidden, no.code, no.message);
    const r = route(req.head.method, target.path);
    var name_buf: [auth.cookie_name_max]u8 = undefined;
    const authed = if (http.cookie(req, auth.cookieName(&name_buf, ctx.port))) |c| auth.matches(c, ctx.token) else false;

    if (r == .index) return index(ctx, arena, req, target, authed);
    if (!authed) {
        if (r == .not_found) return fail(req, .not_found, "not_found", "no such route");
        return fail(req, .unauthorized, "unauthorized", "open the URL zetta printed at startup; it carries the access token");
    }

    return switch (r) {
        .index => unreachable,
        .meta => meta(ctx, arena, req),
        .catalog => catalog(ctx, arena, req),
        .columns => columns(ctx, arena, req, target.query),
        .table => tableDetail(ctx, arena, req, target.query),
        .function => functionDetail(ctx, arena, req, target.query),
        .count => count(ctx, arena, req, target.query),
        .compile => compile(ctx, arena, req, target.query),
        .browse => browse(ctx, arena, req, target.query),
        .query => query(ctx, arena, req, target.query),
        .not_found => fail(req, .not_found, "not_found", "no such route"),
    };
}

fn index(ctx: *const Context, arena: Allocator, req: *Request, target: http.Target, authed: bool) !std.http.Status {
    if (try http.queryParam(arena, target.query, "token")) |given| {
        if (!auth.matches(given, ctx.token)) return fail(req, .unauthorized, "unauthorized", "wrong token");
        // Trade the token for a cookie and drop it from the address bar.
        var buf: [128]u8 = undefined;
        try req.respond("", .{ .status = .see_other, .extra_headers = &.{
            .{ .name = "location", .value = "/" },
            .{ .name = "set-cookie", .value = auth.setCookie(&buf, ctx.port, ctx.token) },
            .{ .name = "cache-control", .value = "no-store" },
        } });
        return .see_other;
    }
    if (!authed) {
        try req.respond(unauthorized_page, .{ .status = .unauthorized, .extra_headers = &.{
            .{ .name = "content-type", .value = "text/html; charset=utf-8" },
            .{ .name = "content-security-policy", .value = unauthorized_csp },
            .{ .name = "x-content-type-options", .value = "nosniff" },
        } });
        return .unauthorized;
    }
    if (!http.acceptsGzip(req)) {
        try req.respond("zetta's UI needs a client that accepts gzip, such as any web browser.\n", .{
            .status = .not_acceptable,
            .extra_headers = &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }},
        });
        return .not_acceptable;
    }
    try req.respond(ui_index_gz, .{ .extra_headers = &.{
        .{ .name = "content-type", .value = "text/html; charset=utf-8" },
        .{ .name = "content-security-policy", .value = ui_csp },
        .{ .name = "content-encoding", .value = "gzip" },
        .{ .name = "vary", .value = "accept-encoding" },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
        .{ .name = "referrer-policy", .value = "no-referrer" },
    } });
    return .ok;
}

/// That page has no script, so none may run. Its only styling is in attributes.
const unauthorized_csp = "default-src 'none'; style-src-attr 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const unauthorized_page =
    \\<!doctype html><meta charset="utf-8"><title>zetta</title>
    \\<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23ea580c'/%3E%3Cg fill='%23fff'%3E%3Crect x='5' y='5' width='4' height='4' rx='1'/%3E%3Crect x='11' y='5' width='4' height='4' rx='1'/%3E%3Crect x='17' y='5' width='4' height='4' rx='1'/%3E%3Crect x='23' y='5' width='4' height='4' rx='1'/%3E%3Crect x='17' y='11' width='4' height='4' rx='1'/%3E%3Crect x='11' y='17' width='4' height='4' rx='1'/%3E%3Crect x='5' y='23' width='4' height='4' rx='1'/%3E%3Crect x='11' y='23' width='4' height='4' rx='1'/%3E%3Crect x='17' y='23' width='4' height='4' rx='1'/%3E%3Crect x='23' y='23' width='4' height='4' rx='1'/%3E%3C/g%3E%3C/svg%3E">
    \\<meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark">
    \\<body style="font:14px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box">
    \\<div role="alert" style="max-width:30rem;padding:20px 24px;border:1px solid #8885;border-radius:10px">
    \\<h1 style="font-size:16px;margin:0 0 8px">This session is not signed in</h1>
    \\<p>zetta only answers browsers that opened the link it printed at startup. Open the URL from
    \\the terminal where you ran <code>zetta serve</code>, the one ending in <code>?token=…</code>.</p>
    \\<p style="margin-bottom:0">If zetta was restarted, it printed a new link and the old one no longer works.</p>
    \\</div>
;

fn meta(ctx: *const Context, arena: Allocator, req: *Request) !std.http.Status {
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.meta(&out.writer, .{ .name = ctx.name, .version = ctx.version, .info = ctx.adapter.info() });
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn catalog(ctx: *const Context, arena: Allocator, req: *Request) !std.http.Status {
    var diag: db.Diagnostic = .{};
    const cat = ctx.adapter.catalog(arena, &diag) catch |err| return dbFail(req, err, &diag);
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.catalog(&out.writer, cat);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn columns(ctx: *const Context, arena: Allocator, req: *Request, query_string: []const u8) !std.http.Status {
    const table = try tableRef(arena, query_string) orelse return fail(req, .bad_request, "bad_request", "schema and table are required");
    var diag: db.Diagnostic = .{};
    const cols = ctx.adapter.columns(arena, table, &diag) catch |err| return dbFail(req, err, &diag);
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.columns(&out.writer, cols);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn tableDetail(ctx: *const Context, arena: Allocator, req: *Request, query_string: []const u8) !std.http.Status {
    const ref = try tableRef(arena, query_string) orelse return fail(req, .bad_request, "bad_request", "schema and table are required");
    var diag: db.Diagnostic = .{};
    const d = ctx.adapter.detail(arena, ref, &diag) catch |err| return dbFail(req, err, &diag);
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.tableDetail(&out.writer, d);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn functionDetail(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    const schema = try http.queryParam(arena, q, "schema") orelse "";
    const name = try http.queryParam(arena, q, "name") orelse "";
    if (schema.len == 0 or name.len == 0) return fail(req, .bad_request, "bad_request", "schema and name are required");
    const arguments = try http.queryParam(arena, q, "args") orelse "";
    var diag: db.Diagnostic = .{};
    const d = ctx.adapter.function(arena, .{ .schema = schema, .name = name, .arguments = arguments }, &diag) catch |err| return dbFail(req, err, &diag);
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.functionDetail(&out.writer, d);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn count(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    const table = try tableRef(arena, q) orelse return fail(req, .bad_request, "bad_request", "schema and table are required");
    const src = switch (try rowSource(arena, q)) {
        .ok => |s| s,
        .bad => |message| return fail(req, .bad_request, "bad_request", message),
    };
    const started = std.Io.Timestamp.now(ctx.io, .awake);
    var diag: db.Diagnostic = .{};
    const n = ctx.adapter.count(arena, .{
        .table = table,
        .filter = src.filter,
        .builder = src.builder,
    }, &diag) catch |err| return dbFail(req, err, &diag);
    const elapsed: u64 = @intCast(@max(0, started.untilNow(ctx.io, .awake).toNanoseconds()));
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.count(&out.writer, n, elapsed);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn browse(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    const table = try tableRef(arena, q) orelse return fail(req, .bad_request, "bad_request", "schema and table are required");
    const limit = if (try http.queryParam(arena, q, "limit")) |s| std.fmt.parseInt(u32, s, 10) catch
        return fail(req, .bad_request, "bad_request", "limit must be a whole number") else 100;
    const offset = if (try http.queryParam(arena, q, "offset")) |s| std.fmt.parseInt(u64, s, 10) catch
        return fail(req, .bad_request, "bad_request", "offset must be a whole number") else 0;
    const src = switch (try rowSource(arena, q)) {
        .ok => |s| s,
        .bad => |message| return fail(req, .bad_request, "bad_request", message),
    };

    const started = std.Io.Timestamp.now(ctx.io, .awake);
    var diag: db.Diagnostic = .{};
    const rs = ctx.adapter.browse(arena, .{
        .table = table,
        .filter = src.filter,
        .order = src.order,
        .builder = src.builder,
        .limit = std.math.clamp(limit, 1, 1000),
        .offset = offset,
        .budget_ms = ctx.statement_timeout_ms,
    }, &diag) catch |err| return dbFail(req, err, &diag);
    return respondResult(ctx, req, rs, started);
}

/// Which rows browse and count look at: the raw `filter` and `order`, or the builder in `q`.
const RowSource = struct {
    filter: ?[]const u8 = null,
    order: ?[]const u8 = null,
    builder: ?db.builder.Builder = null,
};

fn rowSource(arena: Allocator, q: []const u8) !union(enum) { ok: RowSource, bad: []const u8 } {
    const filter: ?[]const u8 = try http.queryParam(arena, q, "filter");
    const order: ?[]const u8 = try http.queryParam(arena, q, "order");
    const text: []const u8 = try http.queryParam(arena, q, "q") orelse "";
    if (text.len == 0) return .{ .ok = .{ .filter = filter, .order = order } };
    if (nonEmpty(filter) or nonEmpty(order)) return .{ .bad = "send either q or filter and order, not both" };
    return switch (try qparam.parse(arena, text)) {
        .ok => |b| .{ .ok = .{ .builder = b } },
        .bad => |message| .{ .bad = message },
    };
}

fn nonEmpty(s: ?[]const u8) bool {
    return if (s) |text| text.len > 0 else false;
}

fn compile(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    const text: []const u8 = try http.queryParam(arena, q, "q") orelse "";
    if (text.len == 0) return fail(req, .bad_request, "bad_request", "q is required");
    const b = switch (try qparam.parse(arena, text)) {
        .ok => |b| b,
        .bad => |message| return fail(req, .bad_request, "bad_request", message),
    };
    const compiled = try db.builder.compile(arena, b, ctx.adapter.info().dialect, .display);
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.compiled(&out.writer, compiled.where, compiled.order);
    try http.respondJson(req, .ok, out.written());
    return .ok;
}

fn query(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    // Read before the body, which can reuse the buffer the head was parsed from.
    const count_param = try http.queryParam(arena, q, "count");
    const exact = if (count_param) |v| std.mem.eql(u8, v, "exact") else false;
    if (req.head.content_length) |len| {
        if (len > http.max_body) return fail(req, .payload_too_large, "too_large", "the SQL is over 1 MiB");
    }
    var body_buf: [4096]u8 = undefined;
    const reader = req.readerExpectNone(&body_buf);
    const sql = reader.allocRemaining(arena, .limited(http.max_body)) catch |err| switch (err) {
        error.StreamTooLong => return fail(req, .payload_too_large, "too_large", "the SQL is over 1 MiB"),
        else => return fail(req, .bad_request, "bad_request", "could not read the request body"),
    };
    if (std.mem.trim(u8, sql, " \t\r\n").len == 0) return fail(req, .bad_request, "bad_request", "the SQL is empty");

    const started = std.Io.Timestamp.now(ctx.io, .awake);
    var diag: db.Diagnostic = .{};
    const options: db.QueryOptions = .{ .exact_count = exact, .budget_ms = ctx.statement_timeout_ms };
    const rs = ctx.adapter.query(arena, sql, options, &diag) catch |err| return dbFail(req, err, &diag);
    return respondResult(ctx, req, rs, started);
}

/// Writes the JSON straight to the socket in chunks, so a large result is never also held as one
/// string. The rows are already in memory, so once the status line is out only a write can fail.
fn respondResult(ctx: *const Context, req: *Request, rs: db.ResultSet, started: std.Io.Timestamp) !std.http.Status {
    const elapsed: u64 = @intCast(@max(0, started.untilNow(ctx.io, .awake).toNanoseconds()));
    var buf: [16 * 1024]u8 = undefined;
    var body = try req.respondStreaming(&buf, .{ .respond_options = .{ .extra_headers = &http.json_headers } });
    try render.json.resultSet(&body.writer, rs, elapsed);
    try body.end();
    return .ok;
}

fn tableRef(arena: Allocator, q: []const u8) !?db.TableRef {
    const schema = try http.queryParam(arena, q, "schema") orelse return null;
    const table = try http.queryParam(arena, q, "table") orelse return null;
    if (schema.len == 0 or table.len == 0) return null;
    return .{ .schema = schema, .table = table };
}

fn fail(req: *Request, status: std.http.Status, code: []const u8, message: []const u8) !std.http.Status {
    try http.respondError(req, status, code, message);
    return status;
}

fn dbFail(req: *Request, err: db.Error, diag: *const db.Diagnostic) !std.http.Status {
    const status: std.http.Status, const code: []const u8 = switch (err) {
        error.ConnectFailed => .{ .bad_gateway, "connect_failed" },
        error.QueryFailed => .{ .bad_request, "db_error" },
        error.ReadOnly => .{ .forbidden, "read_only" },
        error.NotFound => .{ .not_found, "not_found" },
        error.Timeout => .{ .gateway_timeout, "timeout" },
        error.OutOfMemory => .{ .internal_server_error, "internal" },
    };
    return fail(req, status, code, if (diag.message().len > 0) diag.message() else @errorName(err));
}

test "routes" {
    try std.testing.expectEqual(Route.index, route(.GET, "/"));
    try std.testing.expectEqual(Route.query, route(.POST, "/api/query"));
    try std.testing.expectEqual(Route.table, route(.GET, "/api/table"));
    try std.testing.expectEqual(Route.function, route(.GET, "/api/function"));
    try std.testing.expectEqual(Route.count, route(.GET, "/api/count"));
    try std.testing.expectEqual(Route.compile, route(.GET, "/api/compile"));
    try std.testing.expectEqual(Route.not_found, route(.GET, "/api/query"));
    try std.testing.expectEqual(Route.not_found, route(.DELETE, "/api/catalog"));
}

const testing = std.testing;

const Response = struct {
    status: std.http.Status,
    head: []const u8,
    body: []const u8,

    fn header(res: Response, name: []const u8) ?[]const u8 {
        var lines = std.mem.splitSequence(u8, res.head, "\r\n");
        _ = lines.first();
        while (lines.next()) |line| {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            if (std.ascii.eqlIgnoreCase(line[0..colon], name)) return std.mem.trim(u8, line[colon + 1 ..], " ");
        }
        return null;
    }
};

/// Runs one GET through `handle` over in-memory streams, signed in.
fn testGet(ctx: *const Context, arena: Allocator, target: []const u8) !Response {
    return testRequest(ctx, arena, "GET", target, "");
}

fn testRequest(ctx: *const Context, arena: Allocator, method: []const u8, target: []const u8, body: []const u8) !Response {
    var name_buf: [auth.cookie_name_max]u8 = undefined;
    return testSend(ctx, arena, try std.fmt.allocPrint(arena, "{s} {s} HTTP/1.1\r\nhost: 127.0.0.1\r\ncookie: {s}={s}\r\ncontent-length: {d}\r\n\r\n{s}", .{
        method, target, auth.cookieName(&name_buf, ctx.port), ctx.token, body.len, body,
    }));
}

/// Runs the bytes of one whole request through `handle` over in-memory streams.
fn testSend(ctx: *const Context, arena: Allocator, raw: []const u8) !Response {
    var in: std.Io.Reader = .fixed(raw);
    var out: std.Io.Writer.Allocating = .init(arena);
    var server: std.http.Server = .init(&in, &out.writer);
    var req = try server.receiveHead();
    const status = try handle(ctx, arena, &req);
    try out.writer.flush();
    const written = out.written();
    const split = std.mem.indexOf(u8, written, "\r\n\r\n") orelse return error.TestNoBody;
    const head = written[0..split];
    const payload = written[split + 4 ..];
    const chunked = std.ascii.indexOfIgnoreCase(head, "transfer-encoding: chunked") != null;
    return .{ .status = status, .head = head, .body = if (chunked) try dechunk(arena, payload) else payload };
}

fn dechunk(arena: Allocator, body: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var rest = body;
    while (true) {
        const eol = std.mem.indexOf(u8, rest, "\r\n") orelse return error.TestBadChunk;
        const len = try std.fmt.parseInt(usize, rest[0..eol], 16);
        if (len == 0) return out.items;
        rest = rest[eol + 2 ..];
        try out.appendSlice(arena, rest[0..len]);
        rest = rest[len + 2 ..];
    }
}

/// Percent-encodes everything outside the unreserved set.
fn encode(arena: Allocator, s: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (s) |ch| {
        if (std.ascii.isAlphanumeric(ch) or std.mem.indexOfScalar(u8, "-._~", ch) != null) {
            try out.append(arena, ch);
        } else try out.print(arena, "%{X:0>2}", .{ch});
    }
    return out.items;
}

const TestApp = struct {
    arena_state: std.heap.ArenaAllocator,
    ctx: Context,

    fn init(app: *TestApp) !void {
        app.arena_state = .init(testing.allocator);
        errdefer app.arena_state.deinit();
        var diag: db.Diagnostic = .{};
        const target = try db.dsn.parse(app.arena_state.allocator(), ":memory:");
        const adapter = try db.open(testing.allocator, testing.io, target, .{}, &diag);
        app.ctx = .{ .io = testing.io, .adapter = adapter, .token = "t", .name = "zetta", .version = "test" };
    }

    fn deinit(app: *TestApp) void {
        app.ctx.adapter.deinit();
        app.arena_state.deinit();
    }

    fn get(app: *TestApp, path: []const u8, q: ?[]const u8) !Response {
        const arena = app.arena_state.allocator();
        const target = if (q) |text| try std.fmt.allocPrint(arena, "{s}{s}q={s}", .{
            path, if (std.mem.indexOfScalar(u8, path, '?') == null) "?" else "&", try encode(arena, text),
        }) else path;
        return testGet(&app.ctx, arena, target);
    }

    fn post(app: *TestApp, target: []const u8, body: []const u8) !Response {
        return testRequest(&app.ctx, app.arena_state.allocator(), "POST", target, body);
    }

    /// A signed-in request with these header lines in place of the usual Host.
    fn send(app: *TestApp, method: []const u8, target: []const u8, headers: []const u8, body: []const u8) !Response {
        const arena = app.arena_state.allocator();
        var name_buf: [auth.cookie_name_max]u8 = undefined;
        return testSend(&app.ctx, arena, try std.fmt.allocPrint(arena, "{s} {s} HTTP/1.1\r\n{s}cookie: {s}={s}\r\ncontent-length: {d}\r\n\r\n{s}", .{
            method, target, headers, auth.cookieName(&name_buf, app.ctx.port), app.ctx.token, body.len, body,
        }));
    }
};

test "a query stops past the row limit unless asked for an exact count" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const many = "with recursive r(n) as (select 1 union all select n + 1 from r where n < 6000) select n from r";
    const Shape = struct { rows: []const [1][]const u8, rowCount: u64, rowCountExact: bool, truncated: bool };

    const quick = try app.post("/api/query", many);
    try testing.expectEqual(std.http.Status.ok, quick.status);
    const a = try std.json.parseFromSliceLeaky(Shape, app.arena_state.allocator(), quick.body, .{ .ignore_unknown_fields = true });
    try testing.expectEqual(5000, a.rows.len);
    try testing.expectEqual(5001, a.rowCount);
    try testing.expect(!a.rowCountExact and a.truncated);

    const exact = try app.post("/api/query?count=exact", many);
    const b = try std.json.parseFromSliceLeaky(Shape, app.arena_state.allocator(), exact.body, .{ .ignore_unknown_fields = true });
    try testing.expectEqual(5000, b.rows.len);
    try testing.expectEqual(6000, b.rowCount);
    try testing.expect(b.rowCountExact and b.truncated);
}

test "compile shows the builder as SQL with literals and touches no table" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.get("/api/compile",
        \\{"match":"any","filters":[{"c":"status","op":"contains","v":"it's 50%"},{"c":"id","op":"in","v":"1, 2"}],"sorts":[{"c":"id","d":"desc"}]}
    );
    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expectEqualStrings(
        \\{"where":"(\"status\" LIKE '%it''s 50\\%%' ESCAPE '\\') OR (\"id\" IN ('1', '2'))","order":"\"id\" desc"}
    , res.body);
}

test "compile of an empty builder gives empty strings" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.get("/api/compile", "{\"filters\":[{\"c\":\"a\",\"op\":\"eq\",\"v\":\"\"}]}");
    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expectEqualStrings("{\"where\":\"\",\"order\":\"\"}", res.body);
}

test "compile without q, or with a bad q, is a bad request" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const missing = try app.get("/api/compile", null);
    try testing.expectEqual(std.http.Status.bad_request, missing.status);
    try testing.expect(std.mem.indexOf(u8, missing.body, "\"bad_request\"") != null);
    const unknown = try app.get("/api/compile", "{\"filters\":[{\"c\":\"a\",\"op\":\"regex\",\"v\":\"x\"}]}");
    try testing.expectEqual(std.http.Status.bad_request, unknown.status);
    try testing.expect(std.mem.indexOf(u8, unknown.body, "regex") != null);
    const junk = try app.get("/api/compile", "{not json");
    try testing.expectEqual(std.http.Status.bad_request, junk.status);
}

test "q together with a raw filter or order is a bad request" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const b = "{\"filters\":[{\"c\":\"x\",\"op\":\"eq\",\"v\":\"1\"}]}";
    for ([_][]const u8{
        "/api/browse?schema=main&table=t&filter=x%3D1",
        "/api/browse?schema=main&table=t&order=x",
        "/api/count?schema=main&table=t&filter=x%3D1",
    }) |path| {
        const res = try app.get(path, b);
        try testing.expectEqual(std.http.Status.bad_request, res.status);
        try testing.expect(std.mem.indexOf(u8, res.body, "not both") != null);
    }
}

test "browse and count take q and bind its values" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    var diag: db.Diagnostic = .{};
    _ = try app.ctx.adapter.query(app.arena_state.allocator(), "create table t (x integer, s text); insert into t values (1, 'a'), (2, 'b'), (3, 'c')", .{}, &diag);

    const b = "{\"filters\":[{\"c\":\"x\",\"op\":\"gte\",\"v\":\"2\"},{\"c\":\"s\",\"op\":\"neq\",\"v\":\"' or 1=1 --\"}],\"sorts\":[{\"c\":\"x\",\"d\":\"desc\"}]}";
    const counted = try app.get("/api/count?schema=main&table=t", b);
    try testing.expectEqual(std.http.Status.ok, counted.status);
    try testing.expect(std.mem.startsWith(u8, counted.body, "{\"count\":2,"));

    const browsed = try app.get("/api/browse?schema=main&table=t", b);
    try testing.expectEqual(std.http.Status.ok, browsed.status);
    try testing.expect(std.mem.indexOf(u8, browsed.body, "\"rows\":[[\"3\",\"c\"],[\"2\",\"b\"]]") != null);

    const unknown = try app.get("/api/count?schema=main&table=t", "{\"filters\":[{\"c\":\"nope\",\"op\":\"eq\",\"v\":\"1\"}]}");
    try testing.expectEqual(std.http.Status.bad_request, unknown.status);
    try testing.expect(std.mem.indexOf(u8, unknown.body, "\"db_error\"") != null);
}

test "a result larger than one chunk arrives whole and in order" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    var diag: db.Diagnostic = .{};
    _ = try app.ctx.adapter.query(app.arena_state.allocator(),
        \\create table big (n integer, pad text);
        \\insert into big with recursive r(n) as (select 1 union all select n + 1 from r where n < 1000)
        \\select n, printf('%080d', n) from r;
    , .{}, &diag);

    const res = try app.get("/api/browse?schema=main&table=big&limit=1000", null);
    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expect(res.body.len > 64 * 1024);
    const parsed = try std.json.parseFromSliceLeaky(struct { rows: []const [2][]const u8 }, app.arena_state.allocator(), res.body, .{ .ignore_unknown_fields = true });
    try testing.expectEqual(1000, parsed.rows.len);
    for (parsed.rows, 1..) |row, n| try testing.expectEqual(n, try std.fmt.parseInt(usize, row[0], 10));
}

test "a browse past the statement timeout is a 504 that names the budget" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    app.ctx.statement_timeout_ms = 20;
    var diag: db.Diagnostic = .{};
    _ = try app.ctx.adapter.query(app.arena_state.allocator(), "create table t (x integer); insert into t values (1)", .{}, &diag);

    const slow = try encode(app.arena_state.allocator(), "(with recursive r(i) as (select 1 union all select i + 1 from r where i < 100000000) select count(*) from r) > 0");
    const res = try app.get(try std.fmt.allocPrint(app.arena_state.allocator(), "/api/browse?schema=main&table=t&filter={s}", .{slow}), null);
    try testing.expectEqual(std.http.Status.gateway_timeout, res.status);
    try testing.expect(std.mem.indexOf(u8, res.body, "\"timeout\"") != null);
    try testing.expect(std.mem.indexOf(u8, res.body, "20 ms") != null);
}

test "a name repointed at this machine gets nothing, even with the right token" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.send("GET", "/?token=t", "host: evil.example:1993\r\n", "");
    try testing.expectEqual(.forbidden, res.status);
    try testing.expect(std.mem.indexOf(u8, res.body, "\"host_not_allowed\"") != null);
    try testing.expectEqual(null, res.header("set-cookie"));
}

test "a signed-in session cannot be used through a repointed name" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    try testing.expectEqual(.forbidden, (try app.send("GET", "/api/meta", "host: evil.example\r\n", "")).status);
    try testing.expectEqual(.forbidden, (try app.send("POST", "/api/query", "host: evil.example\r\n", "select 1")).status);
    try testing.expectEqual(.forbidden, (try app.send("GET", "/", "host: evil.example\r\naccept-encoding: gzip\r\n", "")).status);
}

test "a request with no Host, or with two, is refused" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    try testing.expectEqual(.forbidden, (try app.send("GET", "/api/meta", "", "")).status);
    try testing.expectEqual(.forbidden, (try app.send("GET", "/api/meta", "host: 127.0.0.1\r\nhost: evil.example\r\n", "")).status);
}

test "a listed host name is answered" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    app.ctx.allowed_hosts = "db.internal";
    try testing.expectEqual(.ok, (try app.send("GET", "/api/meta", "host: db.internal:1993\r\n", "")).status);
    try testing.expectEqual(.forbidden, (try app.send("GET", "/api/meta", "host: other.internal\r\n", "")).status);
}

test "a page on another port cannot run SQL with the session cookie" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    try testing.expectEqual(.ok, (try app.post("/api/query", "create table kept (a)")).status);

    const res = try app.send("POST", "/api/query", "host: 127.0.0.1:1993\r\norigin: http://127.0.0.1:3000\r\n", "drop table kept");
    try testing.expectEqual(.forbidden, res.status);
    try testing.expect(std.mem.indexOf(u8, res.body, "\"origin_not_allowed\"") != null);
    try testing.expectEqual(.ok, (try app.post("/api/query", "select * from kept")).status);
}

test "a same-site GET cannot reach the API, because a filter is SQL" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.send("GET", "/api/meta", "host: 127.0.0.1:1993\r\nsec-fetch-site: same-site\r\n", "");
    try testing.expectEqual(.forbidden, res.status);
}

test "the page's own calls and a typed API URL go through" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const own = "host: 127.0.0.1:1993\r\norigin: http://127.0.0.1:1993\r\nsec-fetch-site: same-origin\r\n";
    try testing.expectEqual(.ok, (try app.send("POST", "/api/query", own, "select 1")).status);
    try testing.expectEqual(.ok, (try app.send("GET", "/api/meta", "host: localhost:1993\r\nsec-fetch-site: none\r\n", "")).status);
}

test "a link from another site still reaches the page, which the cookie then signs in or not" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const arena = app.arena_state.allocator();
    const res = try testSend(&app.ctx, arena, "GET / HTTP/1.1\r\nhost: 127.0.0.1:1993\r\nsec-fetch-site: cross-site\r\n\r\n");
    try testing.expectEqual(.unauthorized, res.status);
}

test "the page carries its policy and cannot be framed" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.send("GET", "/", "host: 127.0.0.1:1993\r\naccept-encoding: gzip\r\n", "");
    try testing.expectEqual(.ok, res.status);
    const csp = res.header("content-security-policy").?;
    try testing.expectEqualStrings(ui_csp, csp);
    try testing.expect(std.mem.indexOf(u8, csp, "frame-ancestors 'none'") != null);
    try testing.expect(std.mem.indexOf(u8, csp, "script-src 'sha256-") != null);
    try testing.expect(std.mem.indexOf(u8, csp, "unsafe-eval") == null);
}

test "the signed-out page allows no script and cannot be framed" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try testSend(&app.ctx, app.arena_state.allocator(), "GET / HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n");
    try testing.expectEqual(.unauthorized, res.status);
    const csp = res.header("content-security-policy").?;
    try testing.expect(std.mem.startsWith(u8, csp, "default-src 'none'"));
    try testing.expect(std.mem.indexOf(u8, csp, "script-src") == null);
    try testing.expect(std.mem.indexOf(u8, csp, "frame-ancestors 'none'") != null);
    try testing.expect(std.mem.indexOf(u8, unauthorized_page, "<script") == null);
}

test "API answers tell a browser not to guess their type" {
    var app: TestApp = undefined;
    try app.init();
    defer app.deinit();
    const res = try app.get("/api/meta", null);
    try testing.expectEqualStrings("nosniff", res.header("x-content-type-options").?);
}

test "every inline script and style in the embedded page is in the embedded policy" {
    const arena_alloc = testing.allocator;
    var arena_state: std.heap.ArenaAllocator = .init(arena_alloc);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var in: std.Io.Reader = .fixed(ui_index_gz);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var inflate: std.compress.flate.Decompress = .init(&in, .gzip, &window);
    const html = try inflate.reader.allocRemaining(arena, .unlimited);

    var found: usize = 0;
    var at: usize = 0;
    while (nextInline(html, at)) |block| : (at = block.end) {
        var digest: [std.crypto.hash.sha2.Sha256.digest_length]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(block.body, &digest, .{});
        var encoded: [std.base64.standard.Encoder.calcSize(digest.len)]u8 = undefined;
        const source = try std.fmt.allocPrint(arena, "'sha256-{s}'", .{std.base64.standard.Encoder.encode(&encoded, &digest)});
        try testing.expect(std.mem.indexOf(u8, ui_csp, source) != null);
        found += 1;
    }
    try testing.expect(found >= 2);
}

/// The next inline script or style at or past `from`, skipping comments as an HTML parser would.
fn nextInline(html: []const u8, from: usize) ?struct { body: []const u8, end: usize } {
    var at = from;
    while (std.mem.indexOfScalarPos(u8, html, at, '<')) |open| {
        const rest = html[open..];
        if (std.mem.startsWith(u8, rest, "<!--")) {
            const close = std.mem.indexOfPos(u8, html, open, "-->") orelse return null;
            at = close + "-->".len;
            continue;
        }
        const closer: []const u8 = if (std.mem.startsWith(u8, rest, "<script")) "</script>" else if (std.mem.startsWith(u8, rest, "<style")) "</style>" else {
            at = open + 1;
            continue;
        };
        const body = (std.mem.indexOfScalarPos(u8, html, open, '>') orelse return null) + 1;
        const end = std.mem.indexOfPos(u8, html, body, closer) orelse return null;
        return .{ .body = html[body..end], .end = end + closer.len };
    }
    return null;
}
