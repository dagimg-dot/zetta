//! One function per route in docs/API.md. Each gets a fresh arena; nothing
//! here knows which database is behind the adapter.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Request = std.http.Server.Request;
const db = @import("db");
const render = @import("render");
const http = @import("http.zig");
const auth = @import("auth.zig");

/// The UI page, gzipped at build time. Every browser accepts gzip, so it is never inflated here.
const ui_index_gz = @embedFile("ui_index");

pub const Context = struct {
    io: std.Io,
    adapter: db.Adapter,
    token: []const u8,
    name: []const u8,
    version: []const u8,
};

const Route = enum { index, meta, catalog, columns, table, count, browse, query, not_found };

fn route(method: std.http.Method, path: []const u8) Route {
    const eql = std.mem.eql;
    if (method == .GET and (eql(u8, path, "/") or eql(u8, path, "/index.html"))) return .index;
    if (method == .GET and eql(u8, path, "/api/meta")) return .meta;
    if (method == .GET and eql(u8, path, "/api/catalog")) return .catalog;
    if (method == .GET and eql(u8, path, "/api/columns")) return .columns;
    if (method == .GET and eql(u8, path, "/api/table")) return .table;
    if (method == .GET and eql(u8, path, "/api/count")) return .count;
    if (method == .GET and eql(u8, path, "/api/browse")) return .browse;
    if (method == .POST and eql(u8, path, "/api/query")) return .query;
    return .not_found;
}

/// Returns the status sent, for the access log.
pub fn handle(ctx: *const Context, arena: Allocator, req: *Request) !std.http.Status {
    const target = http.Target.parse(req.head.target);
    const r = route(req.head.method, target.path);
    const authed = if (http.cookie(req, auth.cookie_name)) |c| auth.matches(c, ctx.token) else false;

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
        .count => count(ctx, arena, req, target.query),
        .browse => browse(ctx, arena, req, target.query),
        .query => query(ctx, arena, req),
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
            .{ .name = "set-cookie", .value = auth.setCookie(&buf, ctx.token) },
            .{ .name = "cache-control", .value = "no-store" },
        } });
        return .see_other;
    }
    if (!authed) {
        try req.respond(unauthorized_page, .{ .status = .unauthorized, .extra_headers = &.{
            .{ .name = "content-type", .value = "text/html; charset=utf-8" },
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
        .{ .name = "content-encoding", .value = "gzip" },
        .{ .name = "vary", .value = "accept-encoding" },
        .{ .name = "cache-control", .value = "no-store" },
        .{ .name = "x-content-type-options", .value = "nosniff" },
        .{ .name = "referrer-policy", .value = "no-referrer" },
    } });
    return .ok;
}

const unauthorized_page =
    \\<!doctype html><meta charset="utf-8"><title>zetta</title>
    \\<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23ea580c'/%3E%3Cg fill='%23fff'%3E%3Crect x='5' y='5' width='4' height='4' rx='1'/%3E%3Crect x='11' y='5' width='4' height='4' rx='1'/%3E%3Crect x='17' y='5' width='4' height='4' rx='1'/%3E%3Crect x='23' y='5' width='4' height='4' rx='1'/%3E%3Crect x='17' y='11' width='4' height='4' rx='1'/%3E%3Crect x='11' y='17' width='4' height='4' rx='1'/%3E%3Crect x='5' y='23' width='4' height='4' rx='1'/%3E%3Crect x='11' y='23' width='4' height='4' rx='1'/%3E%3Crect x='17' y='23' width='4' height='4' rx='1'/%3E%3Crect x='23' y='23' width='4' height='4' rx='1'/%3E%3C/g%3E%3C/svg%3E">
    \\<body style="font:15px system-ui;margin:4rem auto;max-width:32rem;line-height:1.5">
    \\<h1 style="font-size:20px">Open the link zetta printed</h1>
    \\<p>zetta prints a URL with an access token when it starts. Open that URL to sign in.</p>
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

fn count(ctx: *const Context, arena: Allocator, req: *Request, q: []const u8) !std.http.Status {
    const table = try tableRef(arena, q) orelse return fail(req, .bad_request, "bad_request", "schema and table are required");
    const started = std.Io.Timestamp.now(ctx.io, .awake);
    var diag: db.Diagnostic = .{};
    const n = ctx.adapter.count(arena, .{
        .table = table,
        .filter = try http.queryParam(arena, q, "filter"),
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

    const started = std.Io.Timestamp.now(ctx.io, .awake);
    var diag: db.Diagnostic = .{};
    const rs = ctx.adapter.browse(arena, .{
        .table = table,
        .filter = try http.queryParam(arena, q, "filter"),
        .order = try http.queryParam(arena, q, "order"),
        .limit = std.math.clamp(limit, 1, 1000),
        .offset = offset,
    }, &diag) catch |err| return dbFail(req, err, &diag);
    return respondResult(ctx, arena, req, rs, started);
}

fn query(ctx: *const Context, arena: Allocator, req: *Request) !std.http.Status {
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
    const rs = ctx.adapter.query(arena, sql, .{}, &diag) catch |err| return dbFail(req, err, &diag);
    return respondResult(ctx, arena, req, rs, started);
}

fn respondResult(ctx: *const Context, arena: Allocator, req: *Request, rs: db.ResultSet, started: std.Io.Timestamp) !std.http.Status {
    const elapsed: u64 = @intCast(@max(0, started.untilNow(ctx.io, .awake).toNanoseconds()));
    var out: std.Io.Writer.Allocating = .init(arena);
    try render.json.resultSet(&out.writer, rs, elapsed);
    try http.respondJson(req, .ok, out.written());
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
    try std.testing.expectEqual(Route.count, route(.GET, "/api/count"));
    try std.testing.expectEqual(Route.not_found, route(.GET, "/api/query"));
    try std.testing.expectEqual(Route.not_found, route(.DELETE, "/api/catalog"));
}
