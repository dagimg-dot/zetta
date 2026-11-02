const std = @import("std");
const pg = @import("pg.zig");

const index_html = @embedFile("web/index.html");
const max_result_rows = 5000;
const cookie_name = "zetta";

const Config = struct {
    url: [:0]const u8,
    token: []const u8,
};

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    var host: []const u8 = "127.0.0.1";
    var port: u16 = 8080;
    var url: ?[:0]const u8 = null;

    var args = init.minimal.args.iterate();
    _ = args.next();
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--url")) {
            url = args.next() orelse return usage("--url needs a value");
        } else if (std.mem.eql(u8, arg, "--port")) {
            const v = args.next() orelse return usage("--port needs a value");
            port = std.fmt.parseInt(u16, v, 10) catch return usage("bad --port");
        } else if (std.mem.eql(u8, arg, "--host")) {
            host = args.next() orelse return usage("--host needs a value");
        } else {
            return usage("unknown argument");
        }
    }
    if (url == null) {
        if (init.environ_map.get("DATABASE_URL")) |env| url = try init.arena.allocator().dupeZ(u8, env);
    }
    const db_url = url orelse return usage("no database: pass --url or set DATABASE_URL");

    var raw_token: [16]u8 = undefined;
    io.random(&raw_token);
    const token_hex = std.fmt.bytesToHex(raw_token, .lower);
    const cfg: Config = .{ .url = db_url, .token = &token_hex };

    const addr = try std.Io.net.IpAddress.parse(host, port);
    var server = try addr.listen(io, .{ .reuse_address = true });
    defer server.deinit(io);

    std.debug.print("zetta listening on http://{s}:{d}/?token={s}\n", .{ host, port, cfg.token });

    var group: std.Io.Group = .init;
    defer group.cancel(io);
    while (true) {
        const stream = server.accept(io) catch |err| {
            std.log.warn("accept failed: {t}", .{err});
            continue;
        };
        group.concurrent(io, handleConnection, .{ io, gpa, &cfg, stream }) catch {
            stream.close(io);
        };
    }
}

fn usage(msg: []const u8) error{Usage} {
    std.debug.print("{s}\nusage: zetta [--url postgres://...] [--host 127.0.0.1] [--port 8080]\n", .{msg});
    return error.Usage;
}

fn handleConnection(io: std.Io, gpa: std.mem.Allocator, cfg: *const Config, stream: std.Io.net.Stream) void {
    defer stream.close(io);
    var read_buf: [16 * 1024]u8 = undefined;
    var write_buf: [16 * 1024]u8 = undefined;
    var stream_reader = stream.reader(io, &read_buf);
    var stream_writer = stream.writer(io, &write_buf);
    var http_server = std.http.Server.init(&stream_reader.interface, &stream_writer.interface);

    while (true) {
        var req = http_server.receiveHead() catch return;
        handleRequest(gpa, cfg, &req) catch |err| {
            std.log.warn("request failed: {t}", .{err});
            return;
        };
    }
}

const json_headers = [_]std.http.Header{
    .{ .name = "content-type", .value = "application/json" },
    .{ .name = "cache-control", .value = "no-store" },
};

fn handleRequest(gpa: std.mem.Allocator, cfg: *const Config, req: *std.http.Server.Request) !void {
    const target = req.head.target;
    const method = req.head.method;
    const qmark = std.mem.indexOfScalar(u8, target, '?');
    const path = target[0 .. qmark orelse target.len];
    const query = if (qmark) |i| target[i + 1 ..] else "";

    const has_cookie = hasValidCookie(req, cfg.token);

    if (method == .GET and std.mem.eql(u8, path, "/")) {
        const url_token = try queryParam(gpa, query, "token");
        defer if (url_token) |t| gpa.free(t);
        const via_url = if (url_token) |t| std.mem.eql(u8, t, cfg.token) else false;
        if (!via_url and !has_cookie) return respondError(req, .unauthorized, "open the URL printed at startup (it contains the token)");

        var cookie_buf: [128]u8 = undefined;
        const cookie = try std.fmt.bufPrint(&cookie_buf, "{s}={s}; Path=/; HttpOnly; SameSite=Strict", .{ cookie_name, cfg.token });
        return req.respond(index_html, .{ .extra_headers = &.{
            .{ .name = "content-type", .value = "text/html; charset=utf-8" },
            .{ .name = "cache-control", .value = "no-store" },
            .{ .name = "set-cookie", .value = cookie },
        } });
    }

    if (!std.mem.startsWith(u8, path, "/api/")) return respondError(req, .not_found, "not found");
    if (!has_cookie) return respondError(req, .unauthorized, "missing or bad session cookie");

    if (method == .GET and std.mem.eql(u8, path, "/api/schemas")) {
        return runAndRespond(gpa, cfg, req, schemas_sql);
    }
    if (method == .GET and std.mem.eql(u8, path, "/api/table")) {
        return handleTable(gpa, cfg, req, query);
    }
    if (method == .POST and std.mem.eql(u8, path, "/api/query")) {
        // Reading the body invalidates `req.head` slices; nothing above is used after this.
        var body_buf: [4096]u8 = undefined;
        const body_reader = req.readerExpectNone(&body_buf);
        const sql = body_reader.allocRemaining(gpa, .limited(1 << 20)) catch return respondError(req, .bad_request, "body too large or unreadable");
        defer gpa.free(sql);
        const sql_z = try gpa.dupeZ(u8, sql);
        defer gpa.free(sql_z);
        return runAndRespond(gpa, cfg, req, sql_z);
    }
    return respondError(req, .not_found, "no such endpoint");
}

const schemas_sql =
    \\select n.nspname as schema, c.relname as name, c.relkind::text as kind,
    \\       case when c.relkind in ('r','p','m') then c.reltuples::bigint end as approx_rows
    \\from pg_namespace n
    \\left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r','p','v','m','f')
    \\where n.nspname <> 'information_schema' and n.nspname not like 'pg\_%'
    \\order by 1, 2
;

fn handleTable(gpa: std.mem.Allocator, cfg: *const Config, req: *std.http.Server.Request, query: []const u8) !void {
    const schema = (try queryParam(gpa, query, "schema")) orelse return respondError(req, .bad_request, "schema required");
    defer gpa.free(schema);
    const table = (try queryParam(gpa, query, "table")) orelse return respondError(req, .bad_request, "table required");
    defer gpa.free(table);
    const filter = try queryParam(gpa, query, "filter");
    defer if (filter) |f| gpa.free(f);
    const order = try queryParam(gpa, query, "order");
    defer if (order) |o| gpa.free(o);
    const limit_s = try queryParam(gpa, query, "limit");
    defer if (limit_s) |l| gpa.free(l);
    const offset_s = try queryParam(gpa, query, "offset");
    defer if (offset_s) |o| gpa.free(o);

    const limit = std.math.clamp(std.fmt.parseInt(u32, limit_s orelse "100", 10) catch 100, 1, 1000);
    const offset = std.fmt.parseInt(u64, offset_s orelse "0", 10) catch 0;

    var err_msg: []u8 = &.{};
    const conn = (try pg.Conn.open(gpa, cfg.url, &err_msg)) orelse {
        defer gpa.free(err_msg);
        return respondError(req, .bad_gateway, err_msg);
    };
    defer conn.close();

    const q_schema = conn.quoteIdent(gpa, schema) catch return respondError(req, .bad_request, "bad schema name");
    defer gpa.free(q_schema);
    const q_table = conn.quoteIdent(gpa, table) catch return respondError(req, .bad_request, "bad table name");
    defer gpa.free(q_table);

    // `filter` and `order` are raw SQL fragments: the SQL box is just as powerful, so this adds no new access.
    var sql: std.Io.Writer.Allocating = .init(gpa);
    defer sql.deinit();
    try sql.writer.print("select * from {s}.{s}", .{ q_schema, q_table });
    if (filter) |f| if (f.len > 0) try sql.writer.print(" where {s}", .{f});
    if (order) |o| if (o.len > 0) try sql.writer.print(" order by {s}", .{o});
    try sql.writer.print(" limit {d} offset {d}", .{ limit, offset });
    const sql_z = try gpa.dupeZ(u8, sql.written());
    defer gpa.free(sql_z);

    return respondOutcome(gpa, req, try conn.exec(gpa, sql_z));
}

fn runAndRespond(gpa: std.mem.Allocator, cfg: *const Config, req: *std.http.Server.Request, sql: [:0]const u8) !void {
    var err_msg: []u8 = &.{};
    const conn = (try pg.Conn.open(gpa, cfg.url, &err_msg)) orelse {
        defer gpa.free(err_msg);
        return respondError(req, .bad_gateway, err_msg);
    };
    defer conn.close();
    return respondOutcome(gpa, req, try conn.exec(gpa, sql));
}

fn respondOutcome(gpa: std.mem.Allocator, req: *std.http.Server.Request, outcome: pg.Outcome) !void {
    switch (outcome) {
        .err => |msg| {
            defer gpa.free(msg);
            return respondError(req, .bad_request, msg);
        },
        .ok => |res| {
            defer res.deinit();
            var out: std.Io.Writer.Allocating = .init(gpa);
            defer out.deinit();
            try writeResult(&out.writer, res);
            return req.respond(out.written(), .{ .extra_headers = &json_headers });
        },
    }
}

fn respondError(req: *std.http.Server.Request, status: std.http.Status, msg: []const u8) !void {
    var buf: [2048]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    w.writeAll("{\"error\":") catch unreachable;
    jsonString(&w, msg[0..@min(msg.len, 1500)]) catch unreachable;
    w.writeByte('}') catch unreachable;
    return req.respond(w.buffered(), .{ .status = status, .extra_headers = &json_headers });
}

fn writeResult(w: *std.Io.Writer, res: pg.Result) !void {
    const total = res.rowCount();
    const shown = @min(total, max_result_rows);
    const ncols = res.colCount();

    try w.writeAll("{\"columns\":[");
    for (0..ncols) |i| {
        if (i > 0) try w.writeByte(',');
        try jsonString(w, res.colName(i));
    }
    try w.writeAll("],\"rows\":[");
    for (0..shown) |r| {
        if (r > 0) try w.writeByte(',');
        try w.writeByte('[');
        for (0..ncols) |k| {
            if (k > 0) try w.writeByte(',');
            if (res.value(r, k)) |v| try jsonString(w, v) else try w.writeAll("null");
        }
        try w.writeByte(']');
    }
    try w.print("],\"rowCount\":{d},\"truncated\":{s},\"command\":", .{ total, if (total > shown) "true" else "false" });
    try jsonString(w, res.command());
    try w.writeByte('}');
}

fn jsonString(w: *std.Io.Writer, s: []const u8) !void {
    try w.writeByte('"');
    var start: usize = 0;
    for (s, 0..) |ch, i| {
        const esc: ?[]const u8 = switch (ch) {
            '"' => "\\\"",
            '\\' => "\\\\",
            '\n' => "\\n",
            '\r' => "\\r",
            '\t' => "\\t",
            0...8, 11, 12, 14...31 => null,
            else => continue,
        };
        try w.writeAll(s[start..i]);
        if (esc) |e| try w.writeAll(e) else try w.print("\\u{x:0>4}", .{ch});
        start = i + 1;
    }
    try w.writeAll(s[start..]);
    try w.writeByte('"');
}

fn hasValidCookie(req: *const std.http.Server.Request, token: []const u8) bool {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (!std.ascii.eqlIgnoreCase(h.name, "cookie")) continue;
        var parts = std.mem.splitScalar(u8, h.value, ';');
        while (parts.next()) |part| {
            const p = std.mem.trim(u8, part, " ");
            if (!std.mem.startsWith(u8, p, cookie_name ++ "=")) continue;
            if (std.mem.eql(u8, p[cookie_name.len + 1 ..], token)) return true;
        }
    }
    return false;
}

/// Returns a percent-decoded copy of the first `key=value` pair, or null.
fn queryParam(gpa: std.mem.Allocator, query: []const u8, key: []const u8) !?[]u8 {
    var pairs = std.mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (!std.mem.eql(u8, pair[0..eq], key)) continue;
        return try percentDecode(gpa, pair[eq + 1 ..]);
    }
    return null;
}

fn percentDecode(gpa: std.mem.Allocator, s: []const u8) ![]u8 {
    var out = try gpa.alloc(u8, s.len);
    errdefer gpa.free(out);
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const ch = s[i];
        if (ch == '+') {
            out[n] = ' ';
        } else if (ch == '%' and i + 2 < s.len + 0 and std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch null != null) {
            out[n] = std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch unreachable;
            i += 2;
        } else {
            out[n] = ch;
        }
        n += 1;
    }
    return gpa.realloc(out, n);
}

test "percentDecode" {
    const gpa = std.testing.allocator;
    const r = try percentDecode(gpa, "a%20b+c%22");
    defer gpa.free(r);
    try std.testing.expectEqualStrings("a b c\"", r);
}

test "jsonString escapes" {
    var buf: [64]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try jsonString(&w, "a\"b\n\x01");
    try std.testing.expectEqualStrings("\"a\\\"b\\n\\u0001\"", w.buffered());
}
