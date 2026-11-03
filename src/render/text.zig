//! Terminal output: psql-style tables, CSV and the catalog listing.

const std = @import("std");
const Writer = std.Io.Writer;
const db = @import("db");

const max_cell = 60;

pub const TableOptions = struct {
    color: bool = false,
};

pub fn table(w: *Writer, rs: db.ResultSet, options: TableOptions) Writer.Error!void {
    if (rs.columns.len == 0) {
        try w.print("{s}\n", .{rs.command});
        return;
    }

    var widths_buf: [256]usize = undefined;
    const ncols = @min(rs.columns.len, widths_buf.len);
    const widths = widths_buf[0..ncols];
    for (widths, rs.columns[0..ncols]) |*width, col| width.* = displayWidth(col.name);
    for (rs.rows) |row| {
        for (widths, row[0..ncols]) |*width, cell| width.* = @max(width.*, if (cell) |v| displayWidth(v) else 4);
    }

    for (rs.columns[0..ncols], widths, 0..) |col, width, k| {
        try w.writeAll(if (k == 0) " " else " | ");
        try pad(w, col.name, width, .center, k + 1 == ncols);
    }
    try w.writeByte('\n');
    for (widths, 0..) |width, k| {
        if (k > 0) try w.writeByte('+');
        try w.splatByteAll('-', width + 2);
    }
    try w.writeByte('\n');
    for (rs.rows) |row| {
        for (row[0..ncols], rs.columns[0..ncols], widths, 0..) |cell, col, width, k| {
            try w.writeAll(if (k == 0) " " else " | ");
            if (cell) |v| {
                try pad(w, v, width, if (isNumeric(col.type_name)) .right else .left, k + 1 == ncols);
            } else {
                if (options.color) try w.writeAll("\x1b[2m");
                try pad(w, "NULL", width, .left, k + 1 == ncols);
                if (options.color) try w.writeAll("\x1b[0m");
            }
        }
        try w.writeByte('\n');
    }
    const shown = rs.rows.len;
    if (rs.truncated) {
        try w.print("({d} of {d} rows)\n", .{ shown, rs.row_count });
    } else {
        try w.print("({d} row{s})\n", .{ shown, if (shown == 1) "" else "s" });
    }
}

pub fn csv(w: *Writer, rs: db.ResultSet) Writer.Error!void {
    for (rs.columns, 0..) |col, k| {
        if (k > 0) try w.writeByte(',');
        try csvField(w, col.name);
    }
    if (rs.columns.len > 0) try w.writeAll("\r\n");
    for (rs.rows) |row| {
        for (row, 0..) |cell, k| {
            if (k > 0) try w.writeByte(',');
            if (cell) |v| try csvField(w, v);
        }
        try w.writeAll("\r\n");
    }
}

pub fn catalog(w: *Writer, cat: db.Catalog) Writer.Error!void {
    var width: usize = 0;
    for (cat.schemas) |schema| {
        for (schema.tables) |t| width = @max(width, schema.name.len + 1 + t.name.len);
    }
    for (cat.schemas) |schema| {
        if (schema.tables.len == 0) {
            try w.print("{s}.\n", .{schema.name});
            continue;
        }
        for (schema.tables) |t| {
            try w.print("{s}.{s}", .{ schema.name, t.name });
            try w.splatByteAll(' ', width - (schema.name.len + 1 + t.name.len) + 2);
            try w.print("{s}", .{@tagName(t.kind)});
            if (t.approx_rows) |n| try w.print("  ~{d}", .{n});
            try w.writeByte('\n');
        }
    }
}

fn csvField(w: *Writer, v: []const u8) Writer.Error!void {
    const needs_quotes = std.mem.indexOfAny(u8, v, ",\"\r\n") != null;
    if (!needs_quotes) return w.writeAll(v);
    try w.writeByte('"');
    for (v) |ch| {
        if (ch == '"') try w.writeByte('"');
        try w.writeByte(ch);
    }
    try w.writeByte('"');
}

const Align = enum { left, right, center };

/// Writes `v` in `width` columns, with newlines and tabs made visible and
/// long values cut with an ellipsis. The last column gets no trailing spaces.
fn pad(w: *Writer, v: []const u8, width: usize, alignment: Align, last: bool) Writer.Error!void {
    const shown = displayWidth(v);
    const gap = width - shown;
    const before = switch (alignment) {
        .left => 0,
        .right => gap,
        .center => gap / 2,
    };
    try w.splatByteAll(' ', before);
    var count: usize = 0;
    var it = std.unicode.Utf8View.initUnchecked(v).iterator();
    while (it.nextCodepointSlice()) |cp| {
        if (count == max_cell - 1 and displayWidth(v) == max_cell) {
            try w.writeAll("…");
            break;
        }
        switch (cp[0]) {
            '\n' => try w.writeAll("↵"),
            '\t', '\r' => try w.writeByte(' '),
            else => try w.writeAll(cp),
        }
        count += 1;
    }
    if (!last) try w.splatByteAll(' ', gap - before);
}

fn displayWidth(v: []const u8) usize {
    const n = std.unicode.utf8CountCodepoints(v) catch v.len;
    return @min(n, max_cell);
}

fn isNumeric(type_name: []const u8) bool {
    const numeric = [_][]const u8{ "integer", "bigint", "smallint", "numeric", "real", "double precision", "int", "float", "decimal", "money", "oid" };
    for (numeric) |n| if (std.mem.startsWith(u8, type_name, n)) return true;
    return false;
}

const testing = std.testing;

test "tables align numbers right and show NULL" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    const rows = [_]db.Row{ &.{ "1", "alpha" }, &.{ "10", null } };
    try table(&w, .{
        .columns = &.{ .{ .name = "id", .type_name = "integer" }, .{ .name = "name", .type_name = "text" } },
        .rows = &rows,
        .row_count = 2,
        .truncated = false,
        .command = "SELECT 2",
    }, .{});
    try testing.expectEqualStrings(
        \\ id | name
        \\----+-------
        \\  1 | alpha
        \\ 10 | NULL
        \\(2 rows)
        \\
    , w.buffered());
}

test "csv quotes only when it has to" {
    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    const rows = [_]db.Row{&.{ "a,b", null, "say \"hi\"" }};
    try csv(&w, .{
        .columns = &.{ .{ .name = "x", .type_name = "" }, .{ .name = "y", .type_name = "" }, .{ .name = "z", .type_name = "" } },
        .rows = &rows,
        .row_count = 1,
        .truncated = false,
        .command = "",
    });
    try testing.expectEqualStrings("x,y,z\r\n\"a,b\",,\"say \"\"hi\"\"\"\r\n", w.buffered());
}

test "long cells are cut to the cell width" {
    var buf: [256]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try pad(&w, "x" ** 100, max_cell, .left, false);
    try testing.expectEqual(max_cell, try std.unicode.utf8CountCodepoints(w.buffered()));
}
