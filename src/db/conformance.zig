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
    var buf: [2048]u8 = undefined;
    const s = f.schema;
    try exec(f.adapter, try std.fmt.bufPrint(&buf,
        \\create table {s}.items (id integer primary key, name text not null, note text default 'none');
        \\insert into {s}.items (id, name, note) values (1, 'alpha', null), (2, 'beta', 'b'), (3, 'gamma', 'g');
        \\create view {s}.item_names as select name from {s}.items;
        \\create table {s}."we""ird" (x integer);
    , .{ s, s, s, s, s }));
}

fn findSchema(cat: types.Catalog, name: []const u8) ?types.Schema {
    for (cat.schemas) |schema| if (std.mem.eql(u8, schema.name, name)) return schema;
    return null;
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
        try testing.expectEqual(3, schema.tables.len);
        try testing.expectEqualStrings("item_names", schema.tables[0].name);
        try testing.expectEqual(types.TableKind.view, schema.tables[0].kind);
        try testing.expectEqualStrings("items", schema.tables[1].name);
        try testing.expectEqual(types.TableKind.table, schema.tables[1].kind);
        try testing.expectEqualStrings("we\"ird", schema.tables[2].name);
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
    const uri = "file:zetta_ro_test?mode=memory&cache=shared";

    const rw = try open(testing.allocator, testing.io, try dsn.parse(arena, uri), .{}, &diag);
    defer rw.deinit();
    try exec(rw, "create table t (x integer); insert into t values (1);");

    const ro = try open(testing.allocator, testing.io, try dsn.parse(arena, uri), .{ .read_only = true }, &diag);
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
