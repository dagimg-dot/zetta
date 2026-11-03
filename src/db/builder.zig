//! The UI's filter and sort builder, compiled to SQL. The compiler is
//! dialect-neutral; each adapter describes its own SQL in a `Dialect` value.
//! Values are bound as parameters, or for display written as escaped literals,
//! and column names are always quoted, so nothing typed into the builder can
//! change the shape of the statement.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;

pub const Match = enum { all, any };

pub const Op = enum {
    eq,
    neq,
    gt,
    gte,
    lt,
    lte,
    contains,
    starts,
    ends,
    in,
    is_null,
    not_null,
    is_true,
    is_false,

    pub fn takesValue(op: Op) bool {
        return switch (op) {
            .is_null, .not_null, .is_true, .is_false => false,
            else => true,
        };
    }
};

pub const Filter = struct {
    column: []const u8,
    op: Op,
    value: []const u8 = "",
};

pub const SortKey = struct {
    column: []const u8,
    desc: bool = false,
};

pub const Builder = struct {
    match: Match = .all,
    filters: []const Filter = &.{},
    sorts: []const SortKey = &.{},
};

/// Everything about a dialect the compiler needs. Each adapter owns one.
pub const Dialect = struct {
    /// The case-insensitive LIKE keyword.
    like: []const u8,
    /// Appended to a column before LIKE, so any type can be matched as text.
    text_cast: []const u8,
    /// Appended to a column for `is_true` and `is_false`.
    is_true: []const u8,
    is_false: []const u8,
    /// Writes parameter `n`, counting from 1.
    placeholder: *const fn (w: *Writer, n: usize) Writer.Error!void,
    quoteIdent: *const fn (w: *Writer, name: []const u8) Writer.Error!void,
    quoteLiteral: *const fn (w: *Writer, text: []const u8) Writer.Error!void,
};

/// `bind` writes placeholders and collects the values; `display` writes the values as literals.
pub const Mode = enum { bind, display };

pub const Compiled = struct {
    /// The condition for WHERE, or empty.
    where: []const u8,
    /// The list for ORDER BY, or empty.
    order: []const u8,
    /// Parameter values in placeholder order. Empty in display mode.
    params: []const []const u8,

    pub const empty: Compiled = .{ .where = "", .order = "", .params = &.{} };
};

pub fn compile(arena: Allocator, b: Builder, d: *const Dialect, mode: Mode) Allocator.Error!Compiled {
    var params: std.ArrayList([]const u8) = .empty;
    var c: Compiler = .{ .arena = arena, .d = d, .mode = mode, .params = &params };

    var parts: std.ArrayList([]const u8) = .empty;
    for (b.filters) |f| {
        if (try c.filter(f)) |text| try parts.append(arena, text);
    }
    var where: Writer.Allocating = .init(arena);
    for (parts.items, 0..) |text, k| {
        if (k > 0) where.writer.writeAll(if (b.match == .any) " OR " else " AND ") catch return error.OutOfMemory;
        if (parts.items.len > 1) {
            where.writer.print("({s})", .{text}) catch return error.OutOfMemory;
        } else {
            where.writer.writeAll(text) catch return error.OutOfMemory;
        }
    }

    var order: Writer.Allocating = .init(arena);
    var first = true;
    for (b.sorts) |s| {
        if (s.column.len == 0) continue;
        const w = &order.writer;
        if (!first) w.writeAll(", ") catch return error.OutOfMemory;
        first = false;
        d.quoteIdent(w, s.column) catch return error.OutOfMemory;
        w.writeAll(if (s.desc) " desc" else " asc") catch return error.OutOfMemory;
    }

    return .{ .where = where.written(), .order = order.written(), .params = params.items };
}

const Compiler = struct {
    arena: Allocator,
    d: *const Dialect,
    mode: Mode,
    params: *std.ArrayList([]const u8),

    /// One condition, or null for a row the UI has not finished.
    fn filter(c: *Compiler, f: Filter) Allocator.Error!?[]const u8 {
        if (f.column.len == 0) return null;
        if (f.op.takesValue() and f.value.len == 0) return null;
        var out: Writer.Allocating = .init(c.arena);
        const written = c.write(&out.writer, f) catch return error.OutOfMemory;
        return if (written) out.written() else null;
    }

    fn write(c: *Compiler, w: *Writer, f: Filter) (Writer.Error || Allocator.Error)!bool {
        const d = c.d;
        switch (f.op) {
            .eq, .neq, .gt, .gte, .lt, .lte => {
                try d.quoteIdent(w, f.column);
                try w.print(" {s} ", .{comparison(f.op)});
                try c.value(w, f.value);
            },
            .contains, .starts, .ends => {
                try d.quoteIdent(w, f.column);
                try w.print("{s} {s} ", .{ d.text_cast, d.like });
                try c.value(w, try likePattern(c.arena, f.op, f.value));
                try w.writeAll(" ESCAPE '\\'");
            },
            .in => {
                var items = std.mem.splitScalar(u8, f.value, ',');
                var n: usize = 0;
                while (items.next()) |raw| {
                    const item = std.mem.trim(u8, raw, " \t\r\n");
                    if (item.len == 0) continue;
                    if (n == 0) {
                        try d.quoteIdent(w, f.column);
                        try w.writeAll(" IN (");
                    } else try w.writeAll(", ");
                    try c.value(w, item);
                    n += 1;
                }
                if (n == 0) return false;
                try w.writeAll(")");
            },
            .is_null, .not_null => {
                try d.quoteIdent(w, f.column);
                try w.writeAll(if (f.op == .is_null) " IS NULL" else " IS NOT NULL");
            },
            .is_true, .is_false => {
                try d.quoteIdent(w, f.column);
                try w.writeAll(if (f.op == .is_true) d.is_true else d.is_false);
            },
        }
        return true;
    }

    fn value(c: *Compiler, w: *Writer, v: []const u8) (Writer.Error || Allocator.Error)!void {
        switch (c.mode) {
            .display => try c.d.quoteLiteral(w, v),
            .bind => {
                try c.params.append(c.arena, v);
                try c.d.placeholder(w, c.params.items.len);
            },
        }
    }
};

fn comparison(op: Op) []const u8 {
    return switch (op) {
        .eq => "=",
        .neq => "<>",
        .gt => ">",
        .gte => ">=",
        .lt => "<",
        .lte => "<=",
        else => unreachable,
    };
}

/// Escapes `\`, `%` and `_` with `\`, then wraps the value for the operator.
fn likePattern(arena: Allocator, op: Op, v: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    if (op != .starts) try out.append(arena, '%');
    for (v) |ch| {
        if (ch == '\\' or ch == '%' or ch == '_') try out.append(arena, '\\');
        try out.append(arena, ch);
    }
    if (op != .ends) try out.append(arena, '%');
    return out.items;
}

/// ` where ...` from a raw filter, a compiled condition, or both joined with AND.
/// The raw filter sits on its own lines so a trailing `--` comment cannot swallow the rest.
pub fn writeWhere(w: *Writer, raw: ?[]const u8, compiled: []const u8) Writer.Error!void {
    const r = raw orelse "";
    if (r.len > 0 and compiled.len > 0) return w.print(" where (\n{s}\n) and ({s})", .{ r, compiled });
    if (r.len > 0) return w.print(" where (\n{s}\n)", .{r});
    if (compiled.len > 0) try w.print(" where {s}", .{compiled});
}

/// ` order by ...` from a raw list, a compiled list, or the raw one first and then the compiled one.
pub fn writeOrder(w: *Writer, raw: ?[]const u8, compiled: []const u8) Writer.Error!void {
    const r = raw orelse "";
    if (r.len > 0 and compiled.len > 0) return w.print(" order by {s}, {s}", .{ r, compiled });
    if (r.len > 0) return w.print(" order by {s}", .{r});
    if (compiled.len > 0) try w.print(" order by {s}", .{compiled});
}

/// `"name"` with embedded double quotes doubled, the standard SQL form.
pub fn writeDoubleQuoted(w: *Writer, name: []const u8) Writer.Error!void {
    try w.writeByte('"');
    for (name) |ch| {
        if (ch == '"') try w.writeByte('"');
        try w.writeByte(ch);
    }
    try w.writeByte('"');
}

/// `'text'` with embedded single quotes doubled, the standard SQL form.
pub fn writeSingleQuoted(w: *Writer, text: []const u8) Writer.Error!void {
    try w.writeByte('\'');
    for (text) |ch| {
        if (ch == '\'') try w.writeByte('\'');
        try w.writeByte(ch);
    }
    try w.writeByte('\'');
}

const testing = std.testing;

// The adapters' own dialects, so these check the spellings that actually ship.
const test_dialects = struct {
    const postgres = @import("postgres/dialect.zig").dialect;
    const sqlite = @import("sqlite/dialect.zig").dialect;
};

fn displayWhere(arena: Allocator, b: Builder, d: *const Dialect) ![]const u8 {
    return (try compile(arena, b, d, .display)).where;
}

test "values are literals and names are identifiers, whatever is typed" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const b: Builder = .{ .filters = &.{.{ .column = "we\"ird", .op = .eq, .value = "x' or 1=1 --" }} };
    try testing.expectEqualStrings("\"we\"\"ird\" = 'x'' or 1=1 --'", try displayWhere(arena, b, &test_dialects.postgres));
    try testing.expectEqualStrings("\"we\"\"ird\" = 'x'' or 1=1 --'", try displayWhere(arena, b, &test_dialects.sqlite));
}

test "several filters join with AND or OR and are parenthesised" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const filters = [_]Filter{ .{ .column = "a", .op = .gt, .value = "1" }, .{ .column = "b", .op = .is_null } };
    try testing.expectEqualStrings("(\"a\" > '1') OR (\"b\" IS NULL)", try displayWhere(arena, .{ .match = .any, .filters = &filters }, &test_dialects.sqlite));
    try testing.expectEqualStrings("(\"a\" > '1') AND (\"b\" IS NULL)", try displayWhere(arena, .{ .filters = &filters }, &test_dialects.postgres));
}

test "incomplete rows are skipped rather than sent" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    try testing.expectEqualStrings("", try displayWhere(arena, .{ .filters = &.{.{ .column = "a", .op = .eq }} }, &test_dialects.sqlite));
    try testing.expectEqualStrings("", try displayWhere(arena, .{ .filters = &.{.{ .column = "", .op = .is_null }} }, &test_dialects.sqlite));
    try testing.expectEqualStrings("", try displayWhere(arena, .{ .filters = &.{.{ .column = "a", .op = .in, .value = " , ," }} }, &test_dialects.postgres));
    // A skipped row does not count towards the parentheses either.
    const filters = [_]Filter{ .{ .column = "a", .op = .eq }, .{ .column = "b", .op = .not_null } };
    try testing.expectEqualStrings("\"b\" IS NOT NULL", try displayWhere(arena, .{ .filters = &filters }, &test_dialects.postgres));
}

test "contains escapes LIKE wildcards and is case-insensitive on Postgres" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const b: Builder = .{ .filters = &.{.{ .column = "n", .op = .contains, .value = "50%_off" }} };
    try testing.expectEqualStrings("\"n\"::text ILIKE '%50\\%\\_off%' ESCAPE '\\'", try displayWhere(arena, b, &test_dialects.postgres));
    try testing.expectEqualStrings("\"n\" LIKE '%50\\%\\_off%' ESCAPE '\\'", try displayWhere(arena, b, &test_dialects.sqlite));
    const starts: Builder = .{ .filters = &.{.{ .column = "n", .op = .starts, .value = "a\\b" }} };
    try testing.expectEqualStrings("\"n\" LIKE 'a\\\\b%' ESCAPE '\\'", try displayWhere(arena, starts, &test_dialects.sqlite));
    const ends: Builder = .{ .filters = &.{.{ .column = "n", .op = .ends, .value = "z" }} };
    try testing.expectEqualStrings("\"n\" LIKE '%z' ESCAPE '\\'", try displayWhere(arena, ends, &test_dialects.sqlite));
}

test "is one of splits on commas" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const b: Builder = .{ .filters = &.{.{ .column = "s", .op = .in, .value = "paid, shipped," }} };
    try testing.expectEqualStrings("\"s\" IN ('paid', 'shipped')", try displayWhere(arena, b, &test_dialects.sqlite));
    try testing.expectEqualStrings("\"s\" IN ('paid', 'shipped')", try displayWhere(arena, b, &test_dialects.postgres));
}

test "booleans follow the dialect" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const t: Builder = .{ .filters = &.{.{ .column = "x", .op = .is_true }} };
    const f: Builder = .{ .filters = &.{.{ .column = "x", .op = .is_false }} };
    try testing.expectEqualStrings("\"x\" IS TRUE", try displayWhere(arena, t, &test_dialects.postgres));
    try testing.expectEqualStrings("\"x\" = 1", try displayWhere(arena, t, &test_dialects.sqlite));
    try testing.expectEqualStrings("\"x\" IS FALSE", try displayWhere(arena, f, &test_dialects.postgres));
    try testing.expectEqualStrings("\"x\" = 0", try displayWhere(arena, f, &test_dialects.sqlite));
}

test "order joins sort keys in priority order" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const b: Builder = .{ .sorts = &.{ .{ .column = "b", .desc = true }, .{ .column = "a" }, .{ .column = "" } } };
    const c = try compile(arena_state.allocator(), b, &test_dialects.postgres, .display);
    try testing.expectEqualStrings("\"b\" desc, \"a\" asc", c.order);
    try testing.expectEqualStrings("", c.where);
}

test "bound values become numbered placeholders in order" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const b: Builder = .{ .filters = &.{
        .{ .column = "s", .op = .in, .value = "a,b" },
        .{ .column = "n", .op = .contains, .value = "x%" },
        .{ .column = "z", .op = .is_null, .value = "ignored" },
    } };
    const pg = try compile(arena, b, &test_dialects.postgres, .bind);
    try testing.expectEqualStrings("(\"s\" IN ($1, $2)) AND (\"n\"::text ILIKE $3 ESCAPE '\\') AND (\"z\" IS NULL)", pg.where);
    try testing.expectEqual(3, pg.params.len);
    try testing.expectEqualStrings("a", pg.params[0]);
    try testing.expectEqualStrings("b", pg.params[1]);
    try testing.expectEqualStrings("%x\\%%", pg.params[2]);
    const lite = try compile(arena, b, &test_dialects.sqlite, .bind);
    try testing.expectEqualStrings("(\"s\" IN (?1, ?2)) AND (\"n\" LIKE ?3 ESCAPE '\\') AND (\"z\" IS NULL)", lite.where);
}
