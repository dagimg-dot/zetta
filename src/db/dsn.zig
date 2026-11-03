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

/// Writes `text` with any password replaced by `***`.
pub fn redact(text: []const u8, w: *std.Io.Writer) std.Io.Writer.Error!void {
    if (mem.indexOf(u8, text, "://")) |scheme_end| {
        const auth_start = scheme_end + 3;
        const rest = text[auth_start..];
        const host_end = mem.indexOfScalar(u8, rest, '/') orelse rest.len;
        if (mem.lastIndexOfScalar(u8, rest[0..host_end], '@')) |at| {
            if (mem.indexOfScalar(u8, rest[0..at], ':')) |colon| {
                try w.writeAll(text[0 .. auth_start + colon + 1]);
                try w.writeAll("***");
                try w.writeAll(text[auth_start + at ..]);
                return;
            }
        }
    }
    if (mem.indexOf(u8, text, "password=")) |p| {
        const value_start = p + "password=".len;
        const value_end = mem.indexOfScalarPos(u8, text, value_start, ' ') orelse text.len;
        try w.writeAll(text[0..value_start]);
        try w.writeAll("***");
        try w.writeAll(text[value_end..]);
        return;
    }
    try w.writeAll(text);
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
