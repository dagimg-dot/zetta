//! The JSON shapes from docs/API.md, written straight to a writer.

const std = @import("std");
const Writer = std.Io.Writer;
const Stringify = std.json.Stringify;
const db = @import("db");

pub const Meta = struct {
    name: []const u8,
    version: []const u8,
    info: db.Adapter.Info,
};

pub fn meta(w: *Writer, m: Meta) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try field(&s, "name", m.name);
    try field(&s, "version", m.version);
    try field(&s, "adapter", @tagName(m.info.name));
    try field(&s, "database", m.info.database);
    try field(&s, "readOnly", m.info.read_only);
    try s.objectField("capabilities");
    try s.beginObject();
    try field(&s, "schemas", m.info.capabilities.schemas);
    try field(&s, "approxRows", m.info.capabilities.approx_rows);
    try s.endObject();
    try s.endObject();
}

pub fn catalog(w: *Writer, cat: db.Catalog) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try s.objectField("schemas");
    try s.beginArray();
    for (cat.schemas) |schema| {
        try s.beginObject();
        try field(&s, "name", schema.name);
        try s.objectField("tables");
        try s.beginArray();
        for (schema.tables) |t| {
            try s.beginObject();
            try field(&s, "name", t.name);
            try field(&s, "kind", @tagName(t.kind));
            try field(&s, "approxRows", t.approx_rows);
            try s.endObject();
        }
        try s.endArray();
        try s.endObject();
    }
    try s.endArray();
    try s.endObject();
}

pub fn columns(w: *Writer, cols: []const db.Column) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try s.objectField("columns");
    try s.beginArray();
    for (cols) |c| {
        try s.beginObject();
        try field(&s, "name", c.name);
        try field(&s, "type", c.type_name);
        try field(&s, "nullable", c.nullable);
        try field(&s, "primaryKey", c.primary_key);
        try field(&s, "default", c.default);
        try s.endObject();
    }
    try s.endArray();
    try s.endObject();
}

/// `elapsed_ns` is left out when null (the CLI does not time queries). It is written as
/// milliseconds with one decimal, using integer maths so no float formatter is linked in.
pub fn resultSet(w: *Writer, rs: db.ResultSet, elapsed_ns: ?u64) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try s.objectField("columns");
    try s.beginArray();
    for (rs.columns) |c| {
        try s.beginObject();
        try field(&s, "name", c.name);
        try field(&s, "type", c.type_name);
        try s.endObject();
    }
    try s.endArray();
    try s.objectField("rows");
    try s.beginArray();
    for (rs.rows) |row| try s.write(row);
    try s.endArray();
    try field(&s, "rowCount", rs.row_count);
    try field(&s, "truncated", rs.truncated);
    try field(&s, "command", rs.command);
    if (elapsed_ns) |ns| {
        const tenths = (ns + 50_000) / 100_000;
        try s.objectField("elapsedMs");
        try s.print("{d}.{d}", .{ tenths / 10, tenths % 10 });
    }
    try s.endObject();
}

pub fn err(w: *Writer, code: []const u8, message: []const u8) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try field(&s, "error", code);
    try field(&s, "message", message);
    try s.endObject();
}

fn field(s: *Stringify, name: []const u8, value: anytype) Writer.Error!void {
    try s.objectField(name);
    try s.write(value);
}

const testing = std.testing;

test "a result set matches the API shape" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    const rows = [_]db.Row{&.{ "1", null }};
    try resultSet(&w, .{
        .columns = &.{ .{ .name = "id", .type_name = "integer" }, .{ .name = "note", .type_name = "text" } },
        .rows = &rows,
        .row_count = 1,
        .truncated = false,
        .command = "SELECT 1",
    }, 3_140_000);
    try testing.expectEqualStrings(
        \\{"columns":[{"name":"id","type":"integer"},{"name":"note","type":"text"}],"rows":[["1",null]],"rowCount":1,"truncated":false,"command":"SELECT 1","elapsedMs":3.1}
    , w.buffered());
}

test "error bodies escape the database's message" {
    var buf: [128]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try err(&w, "db_error", "syntax error at \"selec\"\nLINE 1");
    try testing.expectEqualStrings(
        \\{"error":"db_error","message":"syntax error at \"selec\"\nLINE 1"}
    , w.buffered());
}
