//! One behaviour suite for every adapter. SQLite always runs in memory;
//! Postgres runs when ZETTA_TEST_PG_URL is set, inside a throwaway schema.

const std = @import("std");
const testing = std.testing;
const Adapter = @import("Adapter.zig");
const Diagnostic = @import("Diagnostic.zig");
const types = @import("types.zig");
const dsn = @import("dsn.zig");
const open = @import("open.zig").open;

const Fixture = struct {
    adapter: Adapter,
    schema: []const u8,
};

fn exec(a: Adapter, text: []const u8) !void {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    _ = a.query(arena_state.allocator(), text, .{}, &diag) catch |err| {
        std.debug.print("setup failed: {s}\n{s}\n", .{ diag.message(), text });
        return err;
    };
}

fn seed(f: Fixture) !void {
    var buf: [4096]u8 = undefined;
    const s = f.schema;
    try exec(f.adapter, try std.fmt.bufPrint(&buf,
        \\create table {s}.items (id integer primary key, name text not null, note text default 'none');
        \\insert into {s}.items (id, name, note) values (1, 'alpha', null), (2, 'beta', 'b'), (3, 'gamma', 'g');
        \\create view {s}.item_names as select name from {s}.items;
        \\create table {s}."we""ird" (x integer);
    , .{ s, s, s, s, s }));

    // Foreign keys, index names and trigger bodies are where the dialects part ways.
    switch (f.adapter.info().name) {
        .sqlite => try exec(f.adapter, try std.fmt.bufPrint(&buf,
            \\create table {s}.parts (
            \\  id integer primary key,
            \\  item_id integer not null references items (id) on delete cascade,
            \\  code text not null unique,
            \\  qty integer not null default 0 check (qty >= 0),
            \\  updated text
            \\);
            \\create index {s}.parts_item on parts (item_id);
            \\create index {s}.parts_low on parts (qty) where qty < 10;
            \\create trigger {s}.parts_touch after update on parts for each row
            \\begin update parts set updated = 'now' where id = new.id; end;
        , .{ s, s, s, s })),
        .postgres => try exec(f.adapter, try std.fmt.bufPrint(&buf,
            \\create table {s}.parts (
            \\  id integer primary key,
            \\  item_id integer not null references {s}.items (id) on delete cascade,
            \\  code text not null unique,
            \\  qty integer not null default 0 check (qty >= 0),
            \\  updated text
            \\);
            \\create index parts_item on {s}.parts (item_id);
            \\create index parts_low on {s}.parts (qty) where qty < 10;
            \\create function {s}.parts_touch() returns trigger language plpgsql as $$ begin return null; end $$;
            \\create trigger parts_touch after update on {s}.parts for each row execute function {s}.parts_touch();
        , .{ s, s, s, s, s, s, s })),
    }
    try exec(f.adapter, try std.fmt.bufPrint(&buf,
        \\insert into {s}.parts (id, item_id, code, qty) values (1, 1, 'a', 5), (2, 1, 'b', 20), (3, 2, 'c', 0);
    , .{s}));
}

fn findSchema(cat: types.Catalog, name: []const u8) ?types.Schema {
    for (cat.schemas) |schema| if (std.mem.eql(u8, schema.name, name)) return schema;
    return null;
}

fn findNamed(comptime T: type, items: []const T, name: []const u8) !T {
    for (items) |item| if (std.mem.eql(u8, item.name, name)) return item;
    std.debug.print("no {s} named {s}\n", .{ @typeName(T), name });
    return error.TestExpectedNamed;
}

fn expectNames(expected: []const []const u8, actual: []const []const u8) !void {
    try testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |e, a| try testing.expectEqualStrings(e, a);
}

fn contains(haystack: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, haystack, needle) != null;
}

fn run(f: Fixture) !void {
    try seed(f);
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var diag: Diagnostic = .{};
    const a = f.adapter;

    // catalog lists tables and views, sorted, with their kinds
    {
        const schema = findSchema(try a.catalog(arena, &diag), f.schema) orelse return error.SchemaMissing;
        try testing.expectEqual(4, schema.tables.len);
        try testing.expectEqualStrings("item_names", schema.tables[0].name);
        try testing.expectEqual(types.TableKind.view, schema.tables[0].kind);
        try testing.expectEqualStrings("items", schema.tables[1].name);
        try testing.expectEqual(types.TableKind.table, schema.tables[1].kind);
        try testing.expectEqualStrings("parts", schema.tables[2].name);
        try testing.expectEqualStrings("we\"ird", schema.tables[3].name);
    }

    // columns report the primary key, nullability and defaults
    {
        const cols = try a.columns(arena, .{ .schema = f.schema, .table = "items" }, &diag);
        try testing.expectEqual(3, cols.len);
        try testing.expect(cols[0].primary_key);
        try testing.expect(!cols[1].nullable);
        try testing.expect(cols[2].nullable);
        try testing.expect(std.mem.indexOf(u8, cols[2].default.?, "none") != null);
    }

    // columns of a missing table is NotFound with a message
    {
        try testing.expectError(error.NotFound, a.columns(arena, .{ .schema = f.schema, .table = "nope" }, &diag));
        try testing.expect(diag.message().len > 0);
    }

    // browse applies filter, order, limit and offset
    {
        const res = try a.browse(arena, .{
            .table = .{ .schema = f.schema, .table = "items" },
            .filter = "id > 1",
            .order = "id desc",
            .limit = 1,
            .offset = 1,
        }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqualStrings("2", res.rows[0][0].?);
        try testing.expectEqualStrings("beta", res.rows[0][1].?);
    }

    // browse quotes identifiers instead of splicing them
    {
        const res = try a.browse(arena, .{ .table = .{ .schema = f.schema, .table = "we\"ird" } }, &diag);
        try testing.expectEqual(0, res.rows.len);
        try testing.expectEqualStrings("x", res.columns[0].name);
    }

    // query returns NULL as null and names every column
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "select id, note from {s}.items order by id", .{f.schema}), .{}, &diag);
        try testing.expectEqual(3, res.row_count);
        try testing.expectEqualStrings("note", res.columns[1].name);
        try testing.expect(res.rows[0][1] == null);
        try testing.expectEqualStrings("SELECT 3", res.command);
    }

    // query truncates past max_rows but still counts every row
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "select * from {s}.items", .{f.schema}), .{ .max_rows = 2 }, &diag);
        try testing.expectEqual(2, res.rows.len);
        try testing.expectEqual(3, res.row_count);
        try testing.expect(res.truncated);
    }

    // a write reports the rows it changed
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "update {s}.items set note = 'x' where id < 3", .{f.schema}), .{}, &diag);
        try testing.expectEqual(0, res.columns.len);
        try testing.expectEqual(2, res.row_count);
        try testing.expect(std.mem.startsWith(u8, res.command, "UPDATE"));
    }

    const parts: types.TableRef = .{ .schema = f.schema, .table = "parts" };

    // detail lists columns and the primary key
    {
        const d = try a.detail(arena, parts, &diag);
        try testing.expectEqualStrings(f.schema, d.schema);
        try testing.expectEqualStrings("parts", d.name);
        try testing.expectEqual(types.TableKind.table, d.kind);
        try testing.expectEqual(5, d.columns.len);
        try testing.expectEqualStrings("id", d.columns[0].name);
        try testing.expect(d.columns[0].primary_key);
        try testing.expect(!d.columns[3].nullable);
        try testing.expect(contains(d.columns[3].default.?, "0"));

        const pk = try findNamed(types.Constraint, d.constraints, "parts_pkey");
        try testing.expectEqual(types.ConstraintKind.primary_key, pk.kind);
        try expectNames(&.{"id"}, pk.columns);
        const unique = try findNamed(types.Constraint, d.constraints, "parts_code_key");
        try testing.expectEqual(types.ConstraintKind.unique, unique.kind);
        try expectNames(&.{"code"}, unique.columns);
        const fk = try findNamed(types.Constraint, d.constraints, "parts_item_id_fkey");
        try testing.expectEqual(types.ConstraintKind.foreign_key, fk.kind);
        try testing.expect(contains(fk.definition, "CASCADE"));
    }

    // detail lists indexes, including a partial one and its predicate
    {
        const d = try a.detail(arena, parts, &diag);
        const plain = try findNamed(types.Index, d.indexes, "parts_item");
        try expectNames(&.{"item_id"}, plain.columns);
        try testing.expect(!plain.unique);
        try testing.expect(!plain.primary);
        try testing.expect(plain.predicate == null);
        try testing.expect(contains(plain.definition.?, "parts_item"));

        const partial = try findNamed(types.Index, d.indexes, "parts_low");
        try expectNames(&.{"qty"}, partial.columns);
        try testing.expect(contains(partial.predicate.?, "qty < 10"));

        const unique = for (d.indexes) |idx| {
            if (idx.unique and !idx.primary) break idx;
        } else return error.TestExpectedUniqueIndex;
        try expectNames(&.{"code"}, unique.columns);
    }

    // detail shows the outgoing foreign key and the incoming reference with CASCADE
    {
        const d = try a.detail(arena, parts, &diag);
        try testing.expectEqual(1, d.foreign_keys.len);
        const fk = d.foreign_keys[0];
        try testing.expectEqualStrings("parts_item_id_fkey", fk.name);
        try expectNames(&.{"item_id"}, fk.columns);
        try testing.expectEqualStrings(f.schema, fk.ref_schema);
        try testing.expectEqualStrings("items", fk.ref_table);
        try expectNames(&.{"id"}, fk.ref_columns);
        try testing.expectEqual(types.FkAction.cascade, fk.on_delete);
        try testing.expectEqual(types.FkAction.no_action, fk.on_update);

        const items = try a.detail(arena, .{ .schema = f.schema, .table = "items" }, &diag);
        try testing.expectEqual(1, items.referenced_by.len);
        const ref = items.referenced_by[0];
        try testing.expectEqualStrings("parts_item_id_fkey", ref.name);
        try testing.expectEqualStrings(f.schema, ref.schema);
        try testing.expectEqualStrings("parts", ref.table);
        try expectNames(&.{"item_id"}, ref.columns);
        try expectNames(&.{"id"}, ref.ref_columns);
        try testing.expectEqual(types.FkAction.cascade, ref.on_delete);
    }

    // detail reads a trigger's timing, events and level
    {
        const d = try a.detail(arena, parts, &diag);
        try testing.expectEqual(1, d.triggers.len);
        const t = d.triggers[0];
        try testing.expectEqualStrings("parts_touch", t.name);
        try testing.expectEqual(types.TriggerTiming.after, t.timing);
        try testing.expectEqualSlices(types.TriggerEvent, &.{.update}, t.events);
        try testing.expectEqual(types.TriggerLevel.row, t.level);
        try testing.expect(t.enabled);
        try testing.expect(contains(t.definition, "parts_touch"));
    }

    // detail DDL mentions the table, its index and its trigger
    {
        const d = try a.detail(arena, parts, &diag);
        try testing.expect(contains(d.ddl, "parts"));
        try testing.expect(contains(d.ddl, "parts_low"));
        try testing.expect(contains(d.ddl, "parts_touch"));
        try testing.expect(std.mem.endsWith(u8, d.ddl, ";"));
    }

    // detail of a view has its kind and its definition
    {
        const d = try a.detail(arena, .{ .schema = f.schema, .table = "item_names" }, &diag);
        try testing.expectEqual(types.TableKind.view, d.kind);
        try testing.expect(d.size_bytes == null);
        try testing.expectEqual(1, d.columns.len);
        try testing.expect(contains(d.ddl, "item_names"));
    }

    // detail quotes the names it looks up
    {
        const d = try a.detail(arena, .{ .schema = f.schema, .table = "we\"ird" }, &diag);
        try testing.expectEqualStrings("we\"ird", d.name);
        try testing.expectEqual(1, d.columns.len);
    }

    // detail of a missing table or schema is NotFound with a message
    {
        try testing.expectError(error.NotFound, a.detail(arena, .{ .schema = f.schema, .table = "nope" }, &diag));
        try testing.expectEqualStrings(try std.fmt.allocPrint(arena, "no table named {s}.nope", .{f.schema}), diag.message());
        try testing.expectError(error.NotFound, a.detail(arena, .{ .schema = "no_such_schema", .table = "parts" }, &diag));
    }

    // count gives every row of a table
    {
        try testing.expectEqual(3, try a.count(arena, .{ .table = .{ .schema = f.schema, .table = "items" } }, &diag));
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts }, &diag));
    }

    // count applies the filter
    {
        try testing.expectEqual(2, try a.count(arena, .{ .table = parts, .filter = "qty < 10" }, &diag));
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts, .filter = "" }, &diag));
        try testing.expectEqual(0, try a.count(arena, .{ .table = parts, .filter = "qty > 100 -- a trailing comment" }, &diag));
    }

    // count with a filter naming an unknown column is QueryFailed with the database's message
    {
        try testing.expectError(error.QueryFailed, a.count(arena, .{ .table = parts, .filter = "nonesuch = 1" }, &diag));
        try testing.expect(contains(diag.message(), "nonesuch"));
    }

    // count runs exactly one statement, whatever the filter holds
    {
        try testing.expectError(error.QueryFailed, a.count(arena, .{ .table = parts, .filter = "1 = 1); delete from parts where (1 = 1" }, &diag));
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts }, &diag));
    }

    // count of a missing table is NotFound, not a query error
    {
        try testing.expectError(error.NotFound, a.count(arena, .{ .table = .{ .schema = f.schema, .table = "nope" } }, &diag));
        try testing.expectEqualStrings(try std.fmt.allocPrint(arena, "no table named {s}.nope", .{f.schema}), diag.message());
        try testing.expectError(error.NotFound, a.count(arena, .{ .table = .{ .schema = "no_such_schema", .table = "items" } }, &diag));
    }

    // count works on a view and on a name that needs quoting
    {
        try testing.expectEqual(3, try a.count(arena, .{ .table = .{ .schema = f.schema, .table = "item_names" } }, &diag));
        try testing.expectEqual(0, try a.count(arena, .{ .table = .{ .schema = f.schema, .table = "we\"ird" } }, &diag));
    }

    // count past its budget is Timeout, and the connection still counts afterwards
    {
        // Each filter takes seconds per row, so a budget of a few milliseconds always runs out.
        const slow = switch (a.info().name) {
            .postgres => "(select true from pg_sleep(2))",
            .sqlite => "(with recursive r(i) as (select 1 union all select i + 1 from r where i < 100000000) select count(*) from r) > 0",
        };
        try testing.expectError(error.Timeout, a.count(arena, .{ .table = parts, .filter = slow, .budget_ms = 20 }, &diag));
        try testing.expect(contains(diag.message(), "20 ms"));
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts }, &diag));
    }

    // a bad statement is QueryFailed with the database's message
    {
        try testing.expectError(error.QueryFailed, a.query(arena, "selec 1", .{}, &diag));
        try testing.expect(std.mem.indexOf(u8, diag.message(), "selec") != null or diag.message().len > 0);
    }
}

test "sqlite passes the adapter suite" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const target = try dsn.parse(arena_state.allocator(), ":memory:");
    const a = try open(testing.allocator, testing.io, target, .{}, &diag);
    defer a.deinit();
    try testing.expectEqual(Adapter.Name.sqlite, a.info().name);
    try run(.{ .adapter = a, .schema = "main" });
}

test "sqlite read-only mode rejects writes" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var diag: Diagnostic = .{};

    // An empty file is a valid empty database, and zetta never creates one itself.
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const file = try tmp.dir.createFile(testing.io, "ro.db", .{});
    file.close(testing.io);
    const path = try std.fmt.allocPrint(arena, ".zig-cache/tmp/{s}/ro.db", .{tmp.sub_path});

    {
        const rw = try open(testing.allocator, testing.io, try dsn.parse(arena, path), .{}, &diag);
        defer rw.deinit();
        try exec(rw, "create table t (x integer); insert into t values (1);");
    }

    const ro = try open(testing.allocator, testing.io, try dsn.parse(arena, path), .{ .read_only = true }, &diag);
    defer ro.deinit();
    try testing.expect(ro.info().read_only);
    const res = try ro.query(arena, "select x from t", .{}, &diag);
    try testing.expectEqual(1, res.row_count);
    try testing.expectError(error.ReadOnly, ro.query(arena, "insert into t values (2)", .{}, &diag));
}

test "sqlite refuses to create a missing file" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const target = try dsn.parse(arena_state.allocator(), "/nonexistent/zetta/missing.db");
    try testing.expectError(error.ConnectFailed, open(testing.allocator, testing.io, target, .{}, &diag));
    try testing.expectEqualStrings("unable to open database file", diag.message());
}

test "postgres passes the adapter suite" {
    const url = testing.environ.getPosix("ZETTA_TEST_PG_URL") orelse return error.SkipZigTest;
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const a = open(testing.allocator, testing.io, try dsn.parse(arena_state.allocator(), url), .{}, &diag) catch |err| {
        std.debug.print("postgres connect failed: {s}\n", .{diag.message()});
        return err;
    };
    defer a.deinit();

    var name_buf: [64]u8 = undefined;
    var rand: [4]u8 = undefined;
    testing.io.random(&rand);
    const schema = try std.fmt.bufPrint(&name_buf, "zetta_conformance_{x}", .{std.mem.readInt(u32, &rand, .little)});
    var buf: [128]u8 = undefined;
    try exec(a, try std.fmt.bufPrint(&buf, "create schema {s}", .{schema}));
    defer exec(a, std.fmt.bufPrint(&buf, "drop schema {s} cascade", .{schema}) catch unreachable) catch {};

    try testing.expectEqual(Adapter.Name.postgres, a.info().name);
    try run(.{ .adapter = a, .schema = schema });
}
