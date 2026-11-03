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

pub fn tableDetail(w: *Writer, d: db.TableDetail) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try field(&s, "schema", d.schema);
    try field(&s, "name", d.name);
    try field(&s, "kind", @tagName(d.kind));
    try field(&s, "approxRows", d.approx_rows);
    try s.objectField("sizeBytes");
    if (d.size_bytes) |sz| {
        try s.beginObject();
        try field(&s, "total", sz.total);
        try field(&s, "table", sz.table);
        try field(&s, "indexes", sz.indexes);
        try s.endObject();
    } else try s.write(null);
    try field(&s, "comment", d.comment);

    try s.objectField("columns");
    try s.beginArray();
    for (d.columns) |c| {
        try s.beginObject();
        try field(&s, "name", c.name);
        try field(&s, "type", c.type_name);
        try field(&s, "nullable", c.nullable);
        try field(&s, "primaryKey", c.primary_key);
        try field(&s, "default", c.default);
        try field(&s, "comment", c.comment);
        try s.endObject();
    }
    try s.endArray();

    try s.objectField("constraints");
    try s.beginArray();
    for (d.constraints) |c| {
        try s.beginObject();
        try field(&s, "name", c.name);
        try field(&s, "kind", @tagName(c.kind));
        try field(&s, "columns", c.columns);
        try field(&s, "definition", c.definition);
        try s.endObject();
    }
    try s.endArray();

    try s.objectField("indexes");
    try s.beginArray();
    for (d.indexes) |i| {
        try s.beginObject();
        try field(&s, "name", i.name);
        try field(&s, "columns", i.columns);
        try field(&s, "unique", i.unique);
        try field(&s, "primary", i.primary);
        try field(&s, "method", i.method);
        try field(&s, "predicate", i.predicate);
        try field(&s, "definition", i.definition);
        try field(&s, "sizeBytes", i.size_bytes);
        try field(&s, "scans", i.scans);
        try s.endObject();
    }
    try s.endArray();

    try s.objectField("foreignKeys");
    try s.beginArray();
    for (d.foreign_keys) |fk| {
        try s.beginObject();
        try field(&s, "name", fk.name);
        try field(&s, "columns", fk.columns);
        try field(&s, "refSchema", fk.ref_schema);
        try field(&s, "refTable", fk.ref_table);
        try field(&s, "refColumns", fk.ref_columns);
        try field(&s, "onUpdate", fk.on_update.text());
        try field(&s, "onDelete", fk.on_delete.text());
        try s.endObject();
    }
    try s.endArray();

    try s.objectField("referencedBy");
    try s.beginArray();
    for (d.referenced_by) |r| {
        try s.beginObject();
        try field(&s, "name", r.name);
        try field(&s, "schema", r.schema);
        try field(&s, "table", r.table);
        try field(&s, "columns", r.columns);
        try field(&s, "refColumns", r.ref_columns);
        try field(&s, "onUpdate", r.on_update.text());
        try field(&s, "onDelete", r.on_delete.text());
        try s.endObject();
    }
    try s.endArray();

    try s.objectField("triggers");
    try s.beginArray();
    for (d.triggers) |t| {
        try s.beginObject();
        try field(&s, "name", t.name);
        try field(&s, "timing", t.timing.text());
        try s.objectField("events");
        try s.beginArray();
        for (t.events) |e| try s.write(e.text());
        try s.endArray();
        try field(&s, "level", t.level.text());
        try field(&s, "function", t.function);
        try field(&s, "definition", t.definition);
        try field(&s, "enabled", t.enabled);
        try s.endObject();
    }
    try s.endArray();

    try field(&s, "ddl", d.ddl);
    try s.endObject();
}

/// `elapsed_ns` is left out when null (the CLI does not time queries).
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
    if (elapsed_ns) |ns| try elapsed(&s, ns);
    try s.endObject();
}

pub fn compiled(w: *Writer, where: []const u8, order: []const u8) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try field(&s, "where", where);
    try field(&s, "order", order);
    try s.endObject();
}

pub fn count(w: *Writer, n: u64, elapsed_ns: u64) Writer.Error!void {
    var s: Stringify = .{ .writer = w };
    try s.beginObject();
    try field(&s, "count", n);
    try elapsed(&s, elapsed_ns);
    try s.endObject();
}

/// Milliseconds with one decimal, using integer maths so no float formatter is linked in.
fn elapsed(s: *Stringify, ns: u64) Writer.Error!void {
    const tenths = (ns + 50_000) / 100_000;
    try s.objectField("elapsedMs");
    try s.print("{d}.{d}", .{ tenths / 10, tenths % 10 });
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

test "a table detail matches the API shape" {
    var buf: [2048]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try tableDetail(&w, .{
        .schema = "main",
        .name = "orders",
        .kind = .table,
        .approx_rows = 4000,
        .size_bytes = .{ .total = 300, .table = 200, .indexes = 100 },
        .comment = null,
        .columns = &.{.{ .name = "id", .type_name = "integer", .nullable = false, .primary_key = true, .default = null, .comment = "key" }},
        .constraints = &.{.{ .name = "orders_pkey", .kind = .primary_key, .columns = &.{"id"}, .definition = "PRIMARY KEY (id)" }},
        .indexes = &.{.{
            .name = "orders_open",
            .columns = &.{ "customer_id", "lower(note)" },
            .unique = false,
            .primary = false,
            .method = "btree",
            .predicate = "status = 'pending'",
            .definition = null,
            .size_bytes = null,
            .scans = 12,
        }},
        .foreign_keys = &.{.{
            .name = "orders_customer_id_fkey",
            .columns = &.{"customer_id"},
            .ref_schema = "main",
            .ref_table = "customers",
            .ref_columns = &.{"id"},
            .on_update = .no_action,
            .on_delete = .set_null,
        }},
        .referenced_by = &.{.{
            .name = "order_items_order_id_fkey",
            .schema = "main",
            .table = "order_items",
            .columns = &.{"order_id"},
            .ref_columns = &.{"id"},
            .on_update = .restrict,
            .on_delete = .cascade,
        }},
        .triggers = &.{.{
            .name = "orders_touch",
            .timing = .instead_of,
            .events = &.{ .insert, .update },
            .level = .row,
            .function = null,
            .definition = "CREATE TRIGGER orders_touch ...",
            .enabled = true,
        }},
        .ddl = "CREATE TABLE orders (id integer);",
    });
    try testing.expectEqualStrings(
        \\{"schema":"main","name":"orders","kind":"table","approxRows":4000,"sizeBytes":{"total":300,"table":200,"indexes":100},"comment":null,
    ++
        \\"columns":[{"name":"id","type":"integer","nullable":false,"primaryKey":true,"default":null,"comment":"key"}],
    ++
        \\"constraints":[{"name":"orders_pkey","kind":"primary_key","columns":["id"],"definition":"PRIMARY KEY (id)"}],
    ++
        \\"indexes":[{"name":"orders_open","columns":["customer_id","lower(note)"],"unique":false,"primary":false,"method":"btree","predicate":"status = 'pending'","definition":null,"sizeBytes":null,"scans":12}],
    ++
        \\"foreignKeys":[{"name":"orders_customer_id_fkey","columns":["customer_id"],"refSchema":"main","refTable":"customers","refColumns":["id"],"onUpdate":"NO ACTION","onDelete":"SET NULL"}],
    ++
        \\"referencedBy":[{"name":"order_items_order_id_fkey","schema":"main","table":"order_items","columns":["order_id"],"refColumns":["id"],"onUpdate":"RESTRICT","onDelete":"CASCADE"}],
    ++
        \\"triggers":[{"name":"orders_touch","timing":"INSTEAD OF","events":["INSERT","UPDATE"],"level":"ROW","function":null,"definition":"CREATE TRIGGER orders_touch ...","enabled":true}],
    ++
        \\"ddl":"CREATE TABLE orders (id integer);"}
    , w.buffered());
}

test "a view without sizes writes null for them" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try tableDetail(&w, .{
        .schema = "public",
        .name = "v",
        .kind = .view,
        .approx_rows = null,
        .size_bytes = null,
        .comment = null,
        .columns = &.{},
        .constraints = &.{},
        .indexes = &.{},
        .foreign_keys = &.{},
        .referenced_by = &.{},
        .triggers = &.{},
        .ddl = "CREATE VIEW v AS\nSELECT 1;",
    });
    try testing.expectEqualStrings(
        \\{"schema":"public","name":"v","kind":"view","approxRows":null,"sizeBytes":null,"comment":null,"columns":[],"constraints":[],"indexes":[],"foreignKeys":[],"referencedBy":[],"triggers":[],"ddl":"CREATE VIEW v AS\nSELECT 1;"}
    , w.buffered());
}

test "compiled SQL matches the API shape" {
    var buf: [128]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try compiled(&w, "\"n\"::text ILIKE '%a\\%%' ESCAPE '\\'", "");
    try testing.expectEqualStrings(
        \\{"where":"\"n\"::text ILIKE '%a\\%%' ESCAPE '\\'","order":""}
    , w.buffered());
}

test "a count matches the API shape" {
    var buf: [64]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try count(&w, 4000, 1_230_000);
    try testing.expectEqualStrings(
        \\{"count":4000,"elapsedMs":1.2}
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
