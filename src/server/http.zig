//! Request parsing and response helpers on top of std.http.

const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;
const Request = std.http.Server.Request;
const render = @import("render");

pub const max_body = 1 << 20;

const json_headers = [_]std.http.Header{
    .{ .name = "content-type", .value = "application/json" },
    .{ .name = "cache-control", .value = "no-store" },
};

pub fn respondJson(req: *Request, status: std.http.Status, body: []const u8) !void {
    try req.respond(body, .{ .status = status, .extra_headers = &json_headers });
}

pub fn respondError(req: *Request, status: std.http.Status, code: []const u8, message: []const u8) !void {
    var buf: [2048]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    render.json.err(&w, code, message[0..@min(message.len, 1500)]) catch unreachable;
    try respondJson(req, status, w.buffered());
}

pub const Target = struct {
    path: []const u8,
    query: []const u8,

    pub fn parse(target: []const u8) Target {
        const q = mem.indexOfScalar(u8, target, '?');
        return .{
            .path = target[0 .. q orelse target.len],
            .query = if (q) |i| target[i + 1 ..] else "",
        };
    }
};

/// The percent-decoded value of the first `key=value` pair, or null.
pub fn queryParam(arena: Allocator, query: []const u8, key: []const u8) Allocator.Error!?[]u8 {
    var pairs = mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const eq = mem.indexOfScalar(u8, pair, '=') orelse continue;
        if (mem.eql(u8, pair[0..eq], key)) return try percentDecode(arena, pair[eq + 1 ..]);
    }
    return null;
}

pub fn percentDecode(arena: Allocator, s: []const u8) Allocator.Error![]u8 {
    const out = try arena.alloc(u8, s.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '+') {
            out[n] = ' ';
        } else if (s[i] == '%' and i + 2 < s.len + 0 and isHex(s[i + 1]) and isHex(s[i + 2])) {
            out[n] = std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch unreachable;
            i += 2;
        } else {
            out[n] = s[i];
        }
        n += 1;
    }
    return out[0..n];
}

fn isHex(ch: u8) bool {
    return std.ascii.isHex(ch);
}

pub fn cookie(req: *const Request, name: []const u8) ?[]const u8 {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (!std.ascii.eqlIgnoreCase(h.name, "cookie")) continue;
        var parts = mem.splitScalar(u8, h.value, ';');
        while (parts.next()) |part| {
            const p = mem.trim(u8, part, " ");
            if (p.len > name.len and mem.startsWith(u8, p, name) and p[name.len] == '=') return p[name.len + 1 ..];
        }
    }
    return null;
}

/// True when `Accept-Encoding` lists gzip without `q=0`.
pub fn acceptsGzip(req: *const Request) bool {
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (!std.ascii.eqlIgnoreCase(h.name, "accept-encoding")) continue;
        if (gzipListed(h.value)) return true;
    }
    return false;
}

fn gzipListed(value: []const u8) bool {
    var codings = mem.splitScalar(u8, value, ',');
    while (codings.next()) |raw| {
        var parts = mem.splitScalar(u8, mem.trim(u8, raw, " "), ';');
        const name = mem.trim(u8, parts.first(), " ");
        if (!std.ascii.eqlIgnoreCase(name, "gzip") and !mem.eql(u8, name, "*")) continue;
        const q = mem.trim(u8, parts.rest(), " ");
        if (mem.eql(u8, q, "q=0") or mem.eql(u8, q, "q=0.0") or mem.eql(u8, q, "q=0.000")) continue;
        return true;
    }
    return false;
}

const testing = std.testing;

test "gzip is accepted unless refused with q=0" {
    try testing.expect(gzipListed("gzip, deflate, br, zstd"));
    try testing.expect(gzipListed("br;q=1.0, GZIP;q=0.5"));
    try testing.expect(gzipListed("*"));
    try testing.expect(!gzipListed("gzip;q=0, br"));
    try testing.expect(!gzipListed("identity"));
    try testing.expect(!gzipListed(""));
}

test "query params are percent-decoded" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const q = "schema=public&filter=id%20%3E%201+and+x&empty=";
    try testing.expectEqualStrings("id > 1 and x", (try queryParam(arena_state.allocator(), q, "filter")).?);
    try testing.expectEqualStrings("", (try queryParam(arena_state.allocator(), q, "empty")).?);
    try testing.expectEqual(null, try queryParam(arena_state.allocator(), q, "missing"));
}

test "a stray percent sign is kept as is" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    try testing.expectEqualStrings("100%", try percentDecode(arena_state.allocator(), "100%"));
    try testing.expectEqualStrings("%zz", try percentDecode(arena_state.allocator(), "%zz"));
}

test "target splits path and query" {
    const t = Target.parse("/api/browse?schema=a");
    try testing.expectEqualStrings("/api/browse", t.path);
    try testing.expectEqualStrings("schema=a", t.query);
}
