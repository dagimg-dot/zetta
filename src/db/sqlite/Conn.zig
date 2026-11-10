//! One SQLite connection plus the statement runner. Used by one thread at a
//! time through the pool, so it opens with SQLITE_OPEN_NOMUTEX.

const std = @import("std");
const Allocator = std.mem.Allocator;
const c = @import("c.zig").c;
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Error = types.Error;

const Conn = @This();
const log = std.log.scoped(.sqlite);

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
    if (config.read_only) {
        // SQL can turn query_only off again, so it only covers temp tables. The file itself is
        // protected by SQLITE_OPEN_READONLY, and with no attach slots VACUUM INTO cannot write a
        // new file, nor ATTACH open another database.
        _ = c.sqlite3_limit(db, c.SQLITE_LIMIT_ATTACHED, 0);
        if (c.sqlite3_exec(db, "pragma query_only = 1", null, null, null) != c.SQLITE_OK) {
            diag.set(std.mem.span(c.sqlite3_errmsg(db)));
            _ = c.sqlite3_close(db);
            return error.ConnectFailed;
        }
    }
    return .{ .raw = db.? };
}

/// Rolls back a transaction the caller's SQL left open, as the Postgres adapter does, so the next
/// request on this pooled connection neither sees its uncommitted rows nor waits on its locks.
pub fn endTransaction(self: *Conn) void {
    if (c.sqlite3_get_autocommit(self.raw) != 0) return;
    if (c.sqlite3_exec(self.raw, "rollback", null, null, null) != c.SQLITE_OK) {
        log.warn("could not roll back a transaction left open: {s}", .{std.mem.span(c.sqlite3_errmsg(self.raw))});
    }
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

/// `name` as is when it needs no quotes, otherwise quoted like `quoteIdent`.
pub fn quoteIfNeeded(arena: Allocator, name: []const u8) Allocator.Error![]const u8 {
    const plain = name.len > 0 and !std.ascii.isDigit(name[0]) and
        for (name) |ch| {
            if (!std.ascii.isAlphanumeric(ch) and ch != '_') break false;
        } else true;
    if (plain and c.sqlite3_keyword_check(name.ptr, @intCast(name.len)) == 0) return name;
    return quoteIdent(arena, name);
}

/// Runs every statement in `text` and returns the result of the last one.
pub fn runAll(self: *Conn, arena: Allocator, text: []const u8, limits: types.Limits, diag: *Diagnostic) Error!types.ResultSet {
    var rest = text;
    var last: types.ResultSet = .empty;
    // Counted across every statement, since earlier results stay in the arena too.
    var bytes: usize = 0;
    while (rest.len > 0) {
        var stmt: ?*c.sqlite3_stmt = null;
        var tail: [*c]const u8 = null;
        const rc = c.sqlite3_prepare_v2(self.raw, rest.ptr, @intCast(rest.len), &stmt, &tail);
        if (rc != c.SQLITE_OK) {
            const err = self.fail(rc, diag);
            const at = c.sqlite3_error_offset(self.raw);
            if (at >= 0) pointAt(diag, text, rest.ptr - text.ptr + @as(usize, @intCast(at)));
            return err;
        }
        const consumed = @intFromPtr(tail) - @intFromPtr(rest.ptr);
        rest = rest[consumed..];
        const s = stmt orelse {
            if (consumed == 0) break;
            continue;
        };
        defer _ = c.sqlite3_finalize(s);
        last = try self.collect(arena, s, limits, &bytes, diag);
    }
    return last;
}

/// Runs one statement with text parameters bound to ?1, ?2, ... Text after the
/// first statement is refused rather than ignored.
pub fn runBound(self: *Conn, arena: Allocator, text: [:0]const u8, params: []const []const u8, diag: *Diagnostic) Error!types.ResultSet {
    return self.runBoundLimited(arena, text, params, .{}, diag);
}

/// As `runBound`, keeping only what `limits` allow.
pub fn runBoundLimited(self: *Conn, arena: Allocator, text: [:0]const u8, params: []const []const u8, limits: types.Limits, diag: *Diagnostic) Error!types.ResultSet {
    var stmt: ?*c.sqlite3_stmt = null;
    var tail: [*c]const u8 = null;
    const rc = c.sqlite3_prepare_v2(self.raw, text.ptr, @intCast(text.len + 1), &stmt, &tail);
    if (rc != c.SQLITE_OK) return self.fail(rc, diag);
    const s = stmt orelse {
        diag.set("the statement is empty");
        return error.QueryFailed;
    };
    defer _ = c.sqlite3_finalize(s);
    const rest = text[@intFromPtr(tail) - @intFromPtr(text.ptr) ..];
    if (std.mem.trim(u8, rest, " \t\r\n;").len > 0) {
        diag.set("only one statement is allowed here");
        return error.QueryFailed;
    }
    for (params, 1..) |p, i| {
        const brc = c.sqlite3_bind_text(s, @intCast(i), p.ptr, @intCast(p.len), c.SQLITE_STATIC);
        if (brc != c.SQLITE_OK) return self.fail(brc, diag);
    }
    var bytes: usize = 0;
    return self.collect(arena, s, limits, &bytes, diag);
}

/// Turns off SQLite's legacy reading of `"name"` as a string when no column has that
/// name, so a quoted column that does not exist is an error. Returns the previous
/// setting for `restoreDoubleQuotedStrings`.
///
/// The return codes below are ignored on purpose: `sqlite3_db_config` fails only with
/// SQLITE_MISUSE for an option the library does not know, and DQS_DML exists in every
/// SQLite since 3.29, so the vendored amalgamation always accepts it.
pub fn strictIdentifiers(self: *Conn) bool {
    var was: c_int = 1;
    _ = c.sqlite3_db_config(self.raw, c.SQLITE_DBCONFIG_DQS_DML, @as(c_int, -1), &was);
    _ = c.sqlite3_db_config(self.raw, c.SQLITE_DBCONFIG_DQS_DML, @as(c_int, 0), @as(?*c_int, null));
    return was != 0;
}

pub fn restoreDoubleQuotedStrings(self: *Conn, was: bool) void {
    _ = c.sqlite3_db_config(self.raw, c.SQLITE_DBCONFIG_DQS_DML, @as(c_int, @intFromBool(was)), @as(?*c_int, null));
}

pub const Deadline = struct {
    io: std.Io,
    at: std.Io.Timestamp,

    pub fn after(io: std.Io, ms: u32) Deadline {
        return .{ .io = io, .at = std.Io.Timestamp.now(io, .awake).addDuration(.fromMilliseconds(ms)) };
    }

    fn passed(d: *const Deadline) bool {
        return std.Io.Timestamp.now(d.io, .awake).nanoseconds >= d.at.nanoseconds;
    }
};

/// VM steps between deadline checks: often enough to stop within a millisecond or so.
const progress_steps = 10_000;

/// `runBound` that stops with error.Timeout once `deadline` passes.
pub fn runBoundUntil(self: *Conn, arena: Allocator, text: [:0]const u8, params: []const []const u8, deadline: *const Deadline, diag: *Diagnostic) Error!types.ResultSet {
    self.setDeadline(deadline);
    defer self.clearDeadline();
    return self.runBound(arena, text, params, diag);
}

/// Every statement run from here on stops with error.Timeout once `deadline` passes, until
/// `clearDeadline`. `deadline` has to outlive that.
pub fn setDeadline(self: *Conn, deadline: *const Deadline) void {
    c.sqlite3_progress_handler(self.raw, progress_steps, onProgress, @constCast(deadline));
}

pub fn clearDeadline(self: *Conn) void {
    c.sqlite3_progress_handler(self.raw, 0, null, null);
}

fn onProgress(ctx: ?*anyopaque) callconv(.c) c_int {
    const deadline: *const Deadline = @ptrCast(@alignCast(ctx.?));
    return @intFromBool(deadline.passed());
}

fn collect(self: *Conn, arena: Allocator, stmt: *c.sqlite3_stmt, limits: types.Limits, bytes: *usize, diag: *Diagnostic) Error!types.ResultSet {
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
    var cut_by_bytes = false;
    // A RETURNING statement makes all its changes on the first step, so stopping early is safe.
    const stopped = while (true) {
        const rc = c.sqlite3_step(stmt);
        if (rc == c.SQLITE_DONE) break false;
        if (rc != c.SQLITE_ROW) return self.fail(rc, diag);
        total += 1;
        if (rows.items.len >= limits.max_rows) {
            if (!limits.exact_count) break true;
            continue;
        }
        if (bytes.* >= limits.max_bytes) {
            cut_by_bytes = true;
            continue;
        }

        const cells = try arena.alloc(?[]const u8, ncols);
        for (cells, cols, 0..) |*cell, *col, k| {
            const kind = c.sqlite3_column_type(stmt, @intCast(k));
            if (col.type_name.len == 0 and kind != c.SQLITE_NULL) col.type_name = storageClass(kind);
            cell.* = try cellValue(arena, stmt, @intCast(k), kind);
            if (cell.*) |v| bytes.* +|= v.len;
        }
        try rows.append(arena, cells);
    };

    if (ncols > 0) {
        return .{
            .columns = cols,
            .rows = rows.items,
            .row_count = total,
            .truncated = total > rows.items.len,
            .truncated_by = if (cut_by_bytes) .bytes else .rows,
            .row_count_exact = !stopped,
            .command = if (stopped) "" else try std.fmt.allocPrint(arena, "SELECT {d}", .{total}),
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

/// Adds the line holding byte `at` of `sql` and a caret under it, the way libpq prints a
/// Postgres error, so the UI finds the spot the same way for both databases.
fn pointAt(diag: *Diagnostic, sql: []const u8, at: usize) void {
    const pos = @min(at, sql.len);
    const line_start = if (std.mem.lastIndexOfScalar(u8, sql[0..pos], '\n')) |i| i + 1 else 0;
    const line_end = std.mem.indexOfScalarPos(u8, sql, pos, '\n') orelse sql.len;
    const line = std.mem.trimEnd(u8, sql[line_start..line_end], "\r");
    const line_no = std.mem.count(u8, sql[0..line_start], "\n") + 1;
    const col = std.unicode.utf8CountCodepoints(sql[line_start..pos]) catch pos - line_start;
    const prefix = std.fmt.count("LINE {d}: ", .{line_no});
    var w: std.Io.Writer = .fixed(diag.buf[diag.len..]);
    // A message that fills the buffer just goes without its caret.
    w.print("\nLINE {d}: {s}\n", .{ line_no, line }) catch return;
    w.splatByteAll(' ', prefix + col) catch return;
    w.writeByte('^') catch return;
    diag.len += w.end;
}

fn fail(self: *Conn, rc: c_int, diag: *Diagnostic) Error {
    diag.set(std.mem.span(c.sqlite3_errmsg(self.raw)));
    return switch (rc & 0xff) {
        c.SQLITE_READONLY => error.ReadOnly,
        c.SQLITE_NOMEM => error.OutOfMemory,
        // Only the progress handler in `runBoundUntil` interrupts a statement.
        c.SQLITE_INTERRUPT => error.Timeout,
        else => error.QueryFailed,
    };
}

test "a syntax error points at its statement's line, not the first match" {
    var diag: Diagnostic = .{};
    diag.set("near \"=\": syntax error");
    pointAt(&diag, "select 1;\nselect 1 where 1 = = 2", 29);
    try std.testing.expectEqualStrings(
        \\near "=": syntax error
        \\LINE 2: select 1 where 1 = = 2
        \\                           ^
    , diag.message());
}

test "identifiers are quoted with embedded quotes doubled" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectEqualStrings("\"we\"\"ird\"", try quoteIdent(arena_state.allocator(), "we\"ird"));
}

test "identifiers are quoted only when they need it" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    try std.testing.expectEqualStrings("order_id", try quoteIfNeeded(arena, "order_id"));
    try std.testing.expectEqualStrings("\"order\"", try quoteIfNeeded(arena, "order"));
    try std.testing.expectEqualStrings("\"two words\"", try quoteIfNeeded(arena, "two words"));
}

fn testConn() !Conn {
    var diag: Diagnostic = .{};
    return connect(.{ .path = ":memory:", .uri = false, .read_only = false }, &diag);
}

/// The detail lines of the plan SQLite picks for `sql`, joined by semicolons.
fn testPlan(conn: *Conn, buf: []u8, sql: [:0]const u8) ![]const u8 {
    var stmt: ?*c.sqlite3_stmt = null;
    if (c.sqlite3_prepare_v2(conn.raw, sql.ptr, -1, &stmt, null) != c.SQLITE_OK) return error.TestPrepare;
    defer _ = c.sqlite3_finalize(stmt);
    var w: std.Io.Writer = .fixed(buf);
    while (c.sqlite3_step(stmt) == c.SQLITE_ROW) try w.print("{s};", .{std.mem.span(c.sqlite3_column_text(stmt, 3))});
    return w.buffered();
}

test "indexed BETWEEN, OR and LIKE prefix filters search the index instead of scanning" {
    var conn = try testConn();
    defer conn.close();
    try std.testing.expectEqual(c.SQLITE_OK, c.sqlite3_exec(conn.raw,
        \\create table t (a integer, b integer, name text collate nocase);
        \\create index t_a on t (a);
        \\create index t_b on t (b);
        \\create index t_name on t (name);
    , null, null, null));
    var buf: [512]u8 = undefined;
    try std.testing.expectStringStartsWith(try testPlan(&conn, &buf, "explain query plan select * from t where a between 1 and 2"), "SEARCH");
    try std.testing.expectStringStartsWith(try testPlan(&conn, &buf, "explain query plan select * from t where a = 1 or b = 2"), "MULTI-INDEX OR");
    try std.testing.expectStringStartsWith(try testPlan(&conn, &buf, "explain query plan select * from t where name like 'ab%'"), "SEARCH");
}

test "VACUUM works on a table with a generated column" {
    var conn = try testConn();
    defer conn.close();
    try std.testing.expectEqual(c.SQLITE_OK, c.sqlite3_exec(conn.raw,
        \\create table g (x integer, y integer generated always as (x * 2));
        \\insert into g (x) values (1);
        \\vacuum;
    , null, null, null));
}

test "the leading keyword skips whitespace" {
    try std.testing.expectEqualStrings("update", leadingKeyword("\n  update t set x = 1"));
}
