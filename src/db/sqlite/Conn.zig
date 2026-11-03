//! One SQLite connection plus the statement runner. Used by one thread at a
//! time through the pool, so it opens with SQLITE_OPEN_NOMUTEX.

const std = @import("std");
const Allocator = std.mem.Allocator;
const c = @import("c.zig").c;
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Error = types.Error;

const Conn = @This();

raw: *c.sqlite3,

pub const Config = struct {
    path: [:0]const u8,
    uri: bool,
    read_only: bool,
};

pub fn isMemory(config: Config) bool {
    return std.mem.eql(u8, config.path, ":memory:") or
        (config.uri and std.mem.indexOf(u8, config.path, "mode=memory") != null);
}

pub fn connect(config: Config, diag: *Diagnostic) Error!Conn {
    var flags: c_int = c.SQLITE_OPEN_NOMUTEX;
    flags |= if (config.read_only) c.SQLITE_OPEN_READONLY else c.SQLITE_OPEN_READWRITE;
    if (config.uri) flags |= c.SQLITE_OPEN_URI;
    // Never create a file by accident; a writable memory database has to be created.
    if (isMemory(config) and !config.read_only) flags |= c.SQLITE_OPEN_CREATE;

    var db: ?*c.sqlite3 = null;
    const rc = c.sqlite3_open_v2(config.path.ptr, &db, flags, null);
    if (rc != c.SQLITE_OK) {
        if (db) |d| {
            diag.set(std.mem.span(c.sqlite3_errmsg(d)));
        } else {
            diag.set("out of memory opening the database");
        }
        _ = c.sqlite3_close(db);
        return error.ConnectFailed;
    }
    _ = c.sqlite3_busy_timeout(db, 5000);
    // SQLITE_OPEN_READONLY is not honoured on a shared-cache connection;
    // query_only is enforced per connection either way.
    if (config.read_only and c.sqlite3_exec(db, "pragma query_only = 1", null, null, null) != c.SQLITE_OK) {
        diag.set(std.mem.span(c.sqlite3_errmsg(db)));
        _ = c.sqlite3_close(db);
        return error.ConnectFailed;
    }
    return .{ .raw = db.? };
}

pub fn close(self: *Conn) void {
    _ = c.sqlite3_close_v2(self.raw);
}

pub fn healthy(_: *Conn) bool {
    return true;
}

/// `main` becomes `"main"`, with embedded quotes doubled.
pub fn quoteIdent(arena: Allocator, ident: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, ident.len + 2);
    out.appendAssumeCapacity('"');
    for (ident) |ch| {
        if (ch == '"') try out.append(arena, '"');
        try out.append(arena, ch);
    }
    try out.append(arena, '"');
    return out.items;
}

/// Runs every statement in `text` and returns the result of the last one.
pub fn runAll(self: *Conn, arena: Allocator, text: []const u8, max_rows: usize, diag: *Diagnostic) Error!types.ResultSet {
    var rest = text;
    var last: types.ResultSet = .empty;
    while (rest.len > 0) {
        var stmt: ?*c.sqlite3_stmt = null;
        var tail: [*c]const u8 = null;
        const rc = c.sqlite3_prepare_v2(self.raw, rest.ptr, @intCast(rest.len), &stmt, &tail);
        if (rc != c.SQLITE_OK) return self.fail(rc, diag);
        const consumed = @intFromPtr(tail) - @intFromPtr(rest.ptr);
        rest = rest[consumed..];
        const s = stmt orelse {
            if (consumed == 0) break;
            continue;
        };
        defer _ = c.sqlite3_finalize(s);
        last = try self.collect(arena, s, max_rows, diag);
    }
    return last;
}

/// Runs one statement with text parameters bound to ?1, ?2, ...
pub fn runBound(self: *Conn, arena: Allocator, text: [:0]const u8, params: []const []const u8, diag: *Diagnostic) Error!types.ResultSet {
    var stmt: ?*c.sqlite3_stmt = null;
    const rc = c.sqlite3_prepare_v2(self.raw, text.ptr, @intCast(text.len + 1), &stmt, null);
    if (rc != c.SQLITE_OK) return self.fail(rc, diag);
    const s = stmt.?;
    defer _ = c.sqlite3_finalize(s);
    for (params, 1..) |p, i| {
        const brc = c.sqlite3_bind_text(s, @intCast(i), p.ptr, @intCast(p.len), c.SQLITE_STATIC);
        if (brc != c.SQLITE_OK) return self.fail(brc, diag);
    }
    return self.collect(arena, s, std.math.maxInt(usize), diag);
}

fn collect(self: *Conn, arena: Allocator, stmt: *c.sqlite3_stmt, max_rows: usize, diag: *Diagnostic) Error!types.ResultSet {
    const ncols: usize = @intCast(c.sqlite3_column_count(stmt));
    const cols = try arena.alloc(types.ResultColumn, ncols);
    for (cols, 0..) |*col, k| {
        const decl = c.sqlite3_column_decltype(stmt, @intCast(k));
        col.* = .{
            .name = try arena.dupe(u8, std.mem.span(c.sqlite3_column_name(stmt, @intCast(k)))),
            .type_name = if (decl != null) try std.ascii.allocLowerString(arena, std.mem.span(decl)) else "",
        };
    }

    var rows: std.ArrayList(types.Row) = .empty;
    var total: u64 = 0;
    while (true) {
        const rc = c.sqlite3_step(stmt);
        if (rc == c.SQLITE_DONE) break;
        if (rc != c.SQLITE_ROW) return self.fail(rc, diag);
        total += 1;
        if (rows.items.len >= max_rows) continue;

        const cells = try arena.alloc(?[]const u8, ncols);
        for (cells, cols, 0..) |*cell, *col, k| {
            const kind = c.sqlite3_column_type(stmt, @intCast(k));
            if (col.type_name.len == 0 and kind != c.SQLITE_NULL) col.type_name = storageClass(kind);
            cell.* = try cellValue(arena, stmt, @intCast(k), kind);
        }
        try rows.append(arena, cells);
    }

    if (ncols > 0) {
        return .{
            .columns = cols,
            .rows = rows.items,
            .row_count = total,
            .truncated = total > rows.items.len,
            .command = try std.fmt.allocPrint(arena, "SELECT {d}", .{total}),
        };
    }
    const verb = try std.ascii.allocUpperString(arena, leadingKeyword(std.mem.span(c.sqlite3_sql(stmt))));
    const changes: u64 = @intCast(c.sqlite3_changes64(self.raw));
    const counts_rows = for ([_][]const u8{ "INSERT", "UPDATE", "DELETE", "REPLACE" }) |v| {
        if (std.mem.eql(u8, verb, v)) break true;
    } else false;
    return .{
        .columns = cols,
        .rows = &.{},
        .row_count = if (counts_rows) changes else 0,
        .truncated = false,
        .command = if (counts_rows) try std.fmt.allocPrint(arena, "{s} {d}", .{ verb, changes }) else verb,
    };
}

fn cellValue(arena: Allocator, stmt: *c.sqlite3_stmt, k: c_int, kind: c_int) Allocator.Error!?[]const u8 {
    switch (kind) {
        c.SQLITE_NULL => return null,
        c.SQLITE_BLOB => {
            const len: usize = @intCast(c.sqlite3_column_bytes(stmt, k));
            const bytes: [*]const u8 = if (len == 0) "" else @ptrCast(c.sqlite3_column_blob(stmt, k));
            const out = try arena.alloc(u8, 2 + len * 2);
            out[0] = '\\';
            out[1] = 'x';
            const hex = "0123456789abcdef";
            for (bytes[0..len], 0..) |b, i| {
                out[2 + i * 2] = hex[b >> 4];
                out[3 + i * 2] = hex[b & 0xf];
            }
            return out;
        },
        else => {
            const text = c.sqlite3_column_text(stmt, k);
            const len: usize = @intCast(c.sqlite3_column_bytes(stmt, k));
            if (text == null) return "";
            return try arena.dupe(u8, text[0..len]);
        },
    }
}

fn storageClass(kind: c_int) []const u8 {
    return switch (kind) {
        c.SQLITE_INTEGER => "integer",
        c.SQLITE_FLOAT => "real",
        c.SQLITE_BLOB => "blob",
        else => "text",
    };
}

fn leadingKeyword(sql: []const u8) []const u8 {
    const start = std.mem.indexOfNone(u8, sql, " \t\r\n") orelse return "";
    var end = start;
    while (end < sql.len and std.ascii.isAlphabetic(sql[end])) end += 1;
    return sql[start..end];
}

fn fail(self: *Conn, rc: c_int, diag: *Diagnostic) Error {
    diag.set(std.mem.span(c.sqlite3_errmsg(self.raw)));
    return switch (rc & 0xff) {
        c.SQLITE_READONLY => error.ReadOnly,
        c.SQLITE_NOMEM => error.OutOfMemory,
        else => error.QueryFailed,
    };
}

test "identifiers are quoted with embedded quotes doubled" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectEqualStrings("\"we\"\"ird\"", try quoteIdent(arena_state.allocator(), "we\"ird"));
}

test "the leading keyword skips whitespace" {
    try std.testing.expectEqualStrings("update", leadingKeyword("\n  update t set x = 1"));
}
