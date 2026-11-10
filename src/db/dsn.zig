//! Turns what the user typed into the adapter to use and its connection
//! target. Nothing here connects.

const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;

pub const Dsn = union(enum) {
    postgres: [:0]const u8,
    sqlite: Sqlite,

    pub const Sqlite = struct {
        path: [:0]const u8,
        /// `path` is a `file:` URI and must be opened with SQLITE_OPEN_URI.
        uri: bool,
    };
};

pub const ParseError = error{ Empty, UnknownScheme } || Allocator.Error;

const sqlite_extensions = [_][]const u8{ ".db", ".sqlite", ".sqlite3", ".db3" };

pub fn parse(arena: Allocator, text: []const u8) ParseError!Dsn {
    const t = mem.trim(u8, text, " \t\r\n");
    if (t.len == 0) return error.Empty;

    if (mem.startsWith(u8, t, "postgres://") or mem.startsWith(u8, t, "postgresql://"))
        return .{ .postgres = try arena.dupeZ(u8, t) };
    if (mem.startsWith(u8, t, "file:"))
        return .{ .sqlite = .{ .path = try arena.dupeZ(u8, t), .uri = true } };
    if (mem.startsWith(u8, t, "sqlite://"))
        return .{ .sqlite = .{ .path = try arena.dupeZ(u8, t["sqlite://".len..]), .uri = false } };
    if (mem.startsWith(u8, t, "sqlite:"))
        return .{ .sqlite = .{ .path = try arena.dupeZ(u8, t["sqlite:".len..]), .uri = false } };
    if (mem.eql(u8, t, ":memory:"))
        return .{ .sqlite = .{ .path = try arena.dupeZ(u8, t), .uri = false } };
    for (sqlite_extensions) |ext| {
        if (mem.endsWith(u8, t, ext)) return .{ .sqlite = .{ .path = try arena.dupeZ(u8, t), .uri = false } };
    }
    if (mem.indexOfScalar(u8, t, '=') != null and mem.indexOf(u8, t, "://") == null)
        return .{ .postgres = try arena.dupeZ(u8, t) };
    return error.UnknownScheme;
}

/// Writes `text` with every password replaced by `***`: the one in a URI's user info, and each
/// `password` or `sslpassword` value in a URI query or a keyword string, quoted or not.
pub fn redact(text: []const u8, w: *std.Io.Writer) std.Io.Writer.Error!void {
    var done: usize = 0;
    if (mem.indexOf(u8, text, "://")) |scheme_end| {
        const auth_start = scheme_end + 3;
        const rest = text[auth_start..];
        const host_end = mem.indexOfAny(u8, rest, "/?") orelse rest.len;
        if (mem.lastIndexOfScalar(u8, rest[0..host_end], '@')) |at| {
            if (mem.indexOfScalar(u8, rest[0..at], ':')) |colon| {
                try w.writeAll(text[0 .. auth_start + colon + 1]);
                try w.writeAll("***");
                done = auth_start + at;
            }
        }
    }
    while (passwordValue(text, done)) |value| {
        try w.writeAll(text[done..value.start]);
        try w.writeAll("***");
        done = value.end;
    }
    try w.writeAll(text[done..]);
}

/// `text` as `redact` writes it.
pub fn redactAlloc(arena: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var out: std.Io.Writer.Allocating = .init(arena);
    redact(text, &out.writer) catch return error.OutOfMemory;
    return out.written();
}

/// Where the next password value at or after `from` starts and ends.
fn passwordValue(text: []const u8, from: usize) ?struct { start: usize, end: usize } {
    var pos = from;
    while (mem.indexOfPos(u8, text, pos, "password")) |k| {
        pos = k + 1;
        const key_start = if (k >= 3 and mem.eql(u8, text[k - 3 .. k], "ssl")) k - 3 else k;
        if (key_start > 0 and mem.indexOfScalar(u8, " \t\r\n?&", text[key_start - 1]) == null) continue;
        var v = k + "password".len;
        while (v < text.len and std.ascii.isWhitespace(text[v])) v += 1;
        if (v >= text.len or text[v] != '=') continue;
        v += 1;
        while (v < text.len and std.ascii.isWhitespace(text[v])) v += 1;
        const quoted = v < text.len and text[v] == '\'';
        var e = if (quoted) v + 1 else v;
        while (e < text.len) : (e += 1) {
            if (text[e] == '\\') {
                e += 1;
            } else if (if (quoted) text[e] == '\'' else (std.ascii.isWhitespace(text[e]) or text[e] == '&')) break;
        }
        if (quoted and e < text.len) e += 1;
        return .{ .start = v, .end = @min(e, text.len) };
    }
    return null;
}

fn expectKind(text: []const u8, comptime kind: std.meta.Tag(Dsn), path: []const u8) !void {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const dsn = try parse(arena_state.allocator(), text);
    try std.testing.expectEqual(kind, std.meta.activeTag(dsn));
    switch (dsn) {
        .postgres => |p| try std.testing.expectEqualStrings(path, p),
        .sqlite => |s| try std.testing.expectEqualStrings(path, s.path),
    }
}

test "postgres URLs and keyword strings pick postgres" {
    try expectKind("postgres://u:p@h:5432/db", .postgres, "postgres://u:p@h:5432/db");
    try expectKind("postgresql://h/db", .postgres, "postgresql://h/db");
    try expectKind("host=localhost dbname=app", .postgres, "host=localhost dbname=app");
}

test "sqlite schemes, URIs and file extensions pick sqlite" {
    try expectKind("sqlite:./app.db", .sqlite, "./app.db");
    try expectKind("sqlite:///tmp/app.db", .sqlite, "/tmp/app.db");
    try expectKind("data/app.sqlite3", .sqlite, "data/app.sqlite3");
    try expectKind(":memory:", .sqlite, ":memory:");
    try expectKind("file:x?mode=memory", .sqlite, "file:x?mode=memory");
}

test "anything else is rejected" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectError(error.UnknownScheme, parse(arena_state.allocator(), "mysql://h/db"));
    try std.testing.expectError(error.Empty, parse(arena_state.allocator(), "  "));
}

fn expectRedacted(text: []const u8, want: []const u8) !void {
    var buf: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try redact(text, &w);
    try std.testing.expectEqualStrings(want, w.buffered());
}

test "passwords never survive redaction" {
    try expectRedacted("postgres://jd:s3cret@127.0.0.1:5544/meridian", "postgres://jd:***@127.0.0.1:5544/meridian");
    try expectRedacted("postgres://jd:p@ss@host/db", "postgres://jd:***@host/db");
    try expectRedacted("host=h password=hunter2 dbname=x", "host=h password=*** dbname=x");
    try expectRedacted("postgres://jd@host/db", "postgres://jd@host/db");
    try expectRedacted("./app.db", "./app.db");
}

test "passwords in every connection string spelling are redacted" {
    try expectRedacted("host=h password = hunter2 dbname=x", "host=h password = *** dbname=x");
    try expectRedacted("host=h password='two words' dbname=x", "host=h password=*** dbname=x");
    try expectRedacted("host=h password='it\\'s here' dbname=x", "host=h password=*** dbname=x");
    try expectRedacted("host=h password=a\\ b dbname=x", "host=h password=*** dbname=x");
    try expectRedacted("password=first", "password=***");
    try expectRedacted("sslkey=k sslpassword=keypass", "sslkey=k sslpassword=***");
    try expectRedacted("postgres://u:p@h/db?password=q&sslmode=require", "postgres://u:***@h/db?password=***&sslmode=require");
    try expectRedacted("postgres://u@h?password=q", "postgres://u@h?password=***");
    try expectRedacted("postgre://u:secretpw@h/db", "postgre://u:***@h/db");
    try expectRedacted("host=h passfile=/x/.pgpass", "host=h passfile=/x/.pgpass");
    try expectRedacted("host=h mypassword=x", "host=h mypassword=x");
}
