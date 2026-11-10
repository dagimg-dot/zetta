//! One behaviour suite for every adapter. SQLite always runs in memory;
//! Postgres runs when ZETTA_TEST_PG_URL is set, inside a throwaway schema.

const std = @import("std");
const testing = std.testing;
const Adapter = @import("Adapter.zig");
const Diagnostic = @import("Diagnostic.zig");
const types = @import("types.zig");
const dsn = @import("dsn.zig");
const open = @import("open.zig").open;
const Builder = @import("builder.zig").Builder;

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
            \\create function {s}.add_one(x integer) returns integer language sql immutable strict as 'select x + 1';
            \\comment on function {s}.add_one(integer) is 'adds one';
            \\create function {s}.add_one(x text, y text default 'a') returns text language sql as 'select x || y';
            \\create procedure {s}.do_nothing() language sql as 'select 1';
            \\create aggregate {s}.total(integer) (sfunc = int4pl, stype = integer);
        , .{ s, s, s, s, s, s, s, s, s, s, s, s })),
    }
    try exec(f.adapter, try std.fmt.bufPrint(&buf,
        \\insert into {s}.parts (id, item_id, code, qty) values (1, 1, 'a%b', 5), (2, 1, 'axb', 20), (3, 2, 'c', 0);
    , .{s}));
}

fn findSchema(cat: types.Catalog, name: []const u8) ?types.Schema {
    for (cat.schemas) |schema| if (std.mem.eql(u8, schema.name, name)) return schema;
    return null;
}

fn findFunction(fns: []const types.Function, name: []const u8) ?types.Function {
    for (fns) |f| if (std.mem.eql(u8, f.name, name)) return f;
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

    // query stops one row past max_rows, so its count is only a lower bound
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "select * from {s}.items", .{f.schema}), .{ .max_rows = 1 }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqual(2, res.row_count);
        try testing.expect(res.truncated and !res.row_count_exact);
        try testing.expectEqual(.rows, res.truncated_by);
    }

    // with exact_count, query truncates past max_rows but still counts every row
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "select * from {s}.items", .{f.schema}), .{ .max_rows = 1, .exact_count = true }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqual(3, res.row_count);
        try testing.expect(res.truncated and res.row_count_exact);
    }

    // several statements still run, and a result that fits is counted exactly
    {
        var buf: [256]u8 = undefined;
        const res = try a.query(arena, try std.fmt.bufPrint(&buf, "select 1; select * from {s}.items", .{f.schema}), .{ .max_rows = 5 }, &diag);
        try testing.expectEqual(3, res.rows.len);
        try testing.expectEqual(3, res.row_count);
        try testing.expect(!res.truncated and res.row_count_exact);
    }

    // stored cells stop at max_bytes, keeping the row that crossed it, and the rest are still counted
    {
        const wide = switch (a.info().name) {
            .postgres => "select repeat('x', 1000) from generate_series(1, 4)",
            .sqlite => "select hex(zeroblob(500)) from (select 1 union all select 2 union all select 3 union all select 4)",
        };
        const res = try a.query(arena, wide, .{ .max_bytes = 1500, .exact_count = true }, &diag);
        try testing.expectEqual(2, res.rows.len);
        try testing.expectEqual(4, res.row_count);
        try testing.expect(res.truncated and res.row_count_exact);
        try testing.expectEqual(.bytes, res.truncated_by);
    }

    // browse keeps to max_bytes too
    {
        const res = try a.browse(arena, .{ .table = .{ .schema = f.schema, .table = "items" }, .max_bytes = 1 }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expect(res.truncated);
        try testing.expectEqual(.bytes, res.truncated_by);
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

    // catalog lists the database's own functions, overloads apart; SQLite can store none
    {
        const schema = findSchema(try a.catalog(arena, &diag), f.schema) orelse return error.SchemaMissing;
        switch (a.info().name) {
            .sqlite => try testing.expectEqual(0, schema.functions.len),
            .postgres => {
                try testing.expectEqual(5, schema.functions.len);
                const fns = schema.functions;
                try testing.expectEqualStrings("add_one", fns[0].name);
                try testing.expectEqualStrings("x integer", fns[0].arguments);
                try testing.expectEqualStrings("integer", fns[0].returns.?);
                try testing.expectEqualStrings("add_one", fns[1].name);
                try testing.expectEqualStrings("x text, y text", fns[1].arguments);
                try testing.expectEqualStrings("do_nothing", fns[2].name);
                try testing.expectEqual(types.FunctionKind.procedure, fns[2].kind);
                try testing.expectEqual(null, fns[2].returns);
                try testing.expectEqualStrings("trigger", fns[3].returns.?);
                try testing.expectEqual(types.FunctionKind.aggregate, fns[4].kind);
            },
        }
    }

    // functions lists what an expression can call by bare name, built-ins included, overloads adjacent
    {
        const fns = try a.functions(arena, &diag);
        const count_fn = findFunction(fns, "count") orelse return error.FunctionMissing;
        try testing.expect(count_fn.kind != .function);
        try testing.expectEqual(types.FunctionKind.function, (findFunction(fns, "lower") orelse return error.FunctionMissing).kind);
        try testing.expectEqual(types.FunctionKind.window, (findFunction(fns, "row_number") orelse return error.FunctionMissing).kind);
        try testing.expect(findFunction(fns, "coalesce") != null);
        for (fns[0 .. fns.len - 1], fns[1..]) |before, after| {
            try testing.expect(std.mem.order(u8, before.name, after.name) != .gt);
        }
        for (fns) |fun| try testing.expect(fun.kind != .procedure);
        if (a.info().name == .sqlite) {
            var variadic_max = false;
            for (fns) |fun| variadic_max = variadic_max or (std.mem.eql(u8, fun.name, "max") and std.mem.eql(u8, fun.arguments, "..."));
            try testing.expect(variadic_max);
        }
        if (a.info().name == .postgres) {
            try testing.expect(findFunction(fns, "int4pl") == null);
            try testing.expect(findFunction(fns, "boolin") == null);
            try testing.expect(findFunction(fns, "hashint4") == null);
            try testing.expect(findFunction(fns, "array_append") != null);
        }
    }

    // function reads one overload by its arguments, and a missing one is not found
    {
        const missing: types.FunctionRef = .{ .schema = f.schema, .name = "no_such_function", .arguments = "" };
        try testing.expectError(error.NotFound, a.function(arena, missing, &diag));
        if (a.info().name == .postgres) {
            const one = try a.function(arena, .{ .schema = f.schema, .name = "add_one", .arguments = "x integer" }, &diag);
            try testing.expectEqualStrings("sql", one.language);
            try testing.expectEqual(types.Volatility.immutable, one.volatility);
            try testing.expect(one.strict);
            try testing.expect(!one.security_definer);
            try testing.expectEqualStrings("adds one", one.comment.?);
            try testing.expect(contains(one.definition.?, "x + 1"));
            try testing.expect(contains(one.call.?, "add_one(/* x integer */)"));

            const other = try a.function(arena, .{ .schema = f.schema, .name = "add_one", .arguments = "x text, y text" }, &diag);
            try testing.expect(contains(other.signature, "DEFAULT"));
            try testing.expectEqualStrings("text", other.returns.?);

            const proc = try a.function(arena, .{ .schema = f.schema, .name = "do_nothing", .arguments = "" }, &diag);
            try testing.expect(std.mem.startsWith(u8, proc.call.?, "call "));

            const aggregate = try a.function(arena, .{ .schema = f.schema, .name = "total", .arguments = "integer" }, &diag);
            try testing.expectEqual(null, aggregate.definition);

            const on_trigger = try a.function(arena, .{ .schema = f.schema, .name = "parts_touch", .arguments = "" }, &diag);
            try testing.expectEqual(null, on_trigger.call);
        }
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

    // query and browse past their budget are Timeout, even while counting rows past max_rows,
    // and a later statement without a budget is not cut short by the earlier one
    {
        const many = "with recursive r(i) as (select 1 union all select i + 1 from r where i < 100000000) select i from r";
        try testing.expectError(error.Timeout, a.query(arena, many, .{ .max_rows = 10, .exact_count = true, .budget_ms = 20 }, &diag));
        try testing.expect(contains(diag.message(), "20 ms"));
        const slow = switch (a.info().name) {
            .postgres => "(select true from pg_sleep(2))",
            .sqlite => "(with recursive r(i) as (select 1 union all select i + 1 from r where i < 100000000) select count(*) from r) > 0",
        };
        try testing.expectError(error.Timeout, a.browse(arena, .{ .table = parts, .filter = slow, .budget_ms = 20 }, &diag));
        try testing.expect(contains(diag.message(), "20 ms"));

        const longer = switch (a.info().name) {
            .postgres => "select pg_sleep(0.1) is not null",
            .sqlite => "with recursive r(i) as (select 1 union all select i + 1 from r where i < 300000) select count(*) > 0 from r",
        };
        _ = try a.query(arena, "select 1", .{ .budget_ms = 20 }, &diag);
        const res = try a.query(arena, longer, .{}, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqual(3, (try a.browse(arena, .{ .table = parts, .budget_ms = 5000 }, &diag)).rows.len);
    }

    // a builder compares a number column with a bound value
    {
        const b: Builder = .{ .filters = &.{.{ .column = "qty", .op = .eq, .value = "20" }} };
        try testing.expectEqual(1, try a.count(arena, .{ .table = parts, .builder = b }, &diag));
        const res = try a.browse(arena, .{ .table = parts, .builder = b }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqualStrings("2", res.rows[0][0].?);
    }

    // a builder's contains matches % literally and ignores case
    {
        const b: Builder = .{ .filters = &.{.{ .column = "code", .op = .contains, .value = "A%B" }} };
        try testing.expectEqual(1, try a.count(arena, .{ .table = parts, .builder = b }, &diag));
        const res = try a.browse(arena, .{ .table = parts, .builder = b }, &diag);
        try testing.expectEqual(1, res.rows.len);
        try testing.expectEqualStrings("a%b", res.rows[0][2].?);
    }

    // a builder's in binds one value per item
    {
        const b: Builder = .{ .filters = &.{.{ .column = "code", .op = .in, .value = "c, axb, ," }} };
        try testing.expectEqual(2, try a.count(arena, .{ .table = parts, .builder = b }, &diag));
        const nums: Builder = .{ .filters = &.{.{ .column = "qty", .op = .in, .value = "0,5" }} };
        try testing.expectEqual(2, try a.count(arena, .{ .table = parts, .builder = nums }, &diag));
    }

    // a builder joins with OR for any and AND for all, and sorts in priority order
    {
        const either: Builder = .{ .match = .any, .filters = &.{
            .{ .column = "qty", .op = .lt, .value = "1" },
            .{ .column = "code", .op = .eq, .value = "a%b" },
        } };
        try testing.expectEqual(2, try a.count(arena, .{ .table = parts, .builder = either }, &diag));
        const both: Builder = .{
            .filters = &.{
                .{ .column = "qty", .op = .gte, .value = "5" },
                .{ .column = "item_id", .op = .eq, .value = "1" },
                .{ .column = "code", .op = .eq, .value = "" },
            },
            .sorts = &.{ .{ .column = "item_id" }, .{ .column = "qty", .desc = true } },
        };
        try testing.expectEqual(2, try a.count(arena, .{ .table = parts, .builder = both }, &diag));
        const res = try a.browse(arena, .{ .table = parts, .builder = both }, &diag);
        try testing.expectEqual(2, res.rows.len);
        try testing.expectEqualStrings("2", res.rows[0][0].?);
        try testing.expectEqualStrings("1", res.rows[1][0].?);
    }

    // a builder tests for null without a value
    {
        const nulls: Builder = .{ .filters = &.{.{ .column = "updated", .op = .is_null }} };
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts, .builder = nulls }, &diag));
        const set: Builder = .{ .filters = &.{.{ .column = "updated", .op = .not_null }} };
        try testing.expectEqual(0, try a.count(arena, .{ .table = parts, .builder = set }, &diag));
    }

    // a builder value is only ever a value, so injected SQL matches nothing and changes nothing
    {
        const b: Builder = .{ .filters = &.{.{ .column = "code", .op = .eq, .value = "x' or 1=1 --" }} };
        try testing.expectEqual(0, try a.count(arena, .{ .table = parts, .builder = b }, &diag));
        const res = try a.browse(arena, .{ .table = parts, .builder = b }, &diag);
        try testing.expectEqual(0, res.rows.len);
        const drop: Builder = .{ .filters = &.{.{ .column = "code", .op = .contains, .value = "'); delete from parts; --" }} };
        try testing.expectEqual(0, try a.count(arena, .{ .table = parts, .builder = drop }, &diag));
        try testing.expectEqual(3, try a.count(arena, .{ .table = parts }, &diag));
    }

    // a builder naming an unknown column is the database's own query error
    {
        const b: Builder = .{ .filters = &.{.{ .column = "nonesuch", .op = .eq, .value = "1" }} };
        try testing.expectError(error.QueryFailed, a.count(arena, .{ .table = parts, .builder = b }, &diag));
        try testing.expect(contains(diag.message(), "nonesuch"));
        try testing.expectError(error.QueryFailed, a.browse(arena, .{ .table = parts, .builder = b }, &diag));
    }

    // a transaction left open ends with its request, rolled back, whether its SQL ran or failed
    {
        const s = f.schema;
        _ = try a.query(arena, try std.fmt.allocPrint(arena, "begin; update {s}.items set name = 'open' where id = 1", .{s}), .{}, &diag);
        try testing.expectError(error.QueryFailed, a.query(arena, try std.fmt.allocPrint(arena, "begin; update {s}.items set name = 'failed' where id = 2; selec", .{s}), .{}, &diag));
        const res = try a.query(arena, try std.fmt.allocPrint(arena, "select name from {s}.items where id in (1, 2) order by id", .{s}), .{}, &diag);
        try testing.expectEqualStrings("alpha", res.rows[0][0].?);
        try testing.expectEqualStrings("beta", res.rows[1][0].?);
        // and the connection takes a new one
        _ = try a.query(arena, "begin; commit", .{}, &diag);
    }

    // COPY FROM STDIN fails with the reason, as one statement or in a script, and the connection goes on
    if (a.info().name == .postgres) {
        const copy = try std.fmt.allocPrint(arena, "copy {s}.items (name) from stdin", .{f.schema});
        for ([_]types.QueryOptions{ .{}, .{ .exact_count = true } }) |options| {
            try testing.expectError(error.QueryFailed, a.query(arena, copy, options, &diag));
            try testing.expect(contains(diag.message(), "COPY FROM STDIN"));
            const res = try a.query(arena, "select 1", options, &diag);
            try testing.expectEqualStrings("1", res.rows[0][0].?);
        }
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

    // SQL can switch query_only off, but still cannot write a new file or open another database.
    const copy = try std.fmt.allocPrint(arena, ".zig-cache/tmp/{s}/copy.db", .{tmp.sub_path});
    try testing.expectError(error.QueryFailed, ro.query(arena, try std.fmt.allocPrint(arena, "pragma query_only = 0; vacuum into '{s}'", .{copy}), .{}, &diag));
    try testing.expectError(error.FileNotFound, tmp.dir.access(testing.io, "copy.db", .{}));
    try testing.expectError(error.QueryFailed, ro.query(arena, try std.fmt.allocPrint(arena, "attach '{s}' as other", .{path}), .{}, &diag));
}

test "sqlite refuses to create a missing file" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const target = try dsn.parse(arena_state.allocator(), "/nonexistent/zetta/missing.db");
    try testing.expectError(error.ConnectFailed, open(testing.allocator, testing.io, target, .{}, &diag));
    try testing.expectEqualStrings("unable to open database file", diag.message());
}

test "postgres read-only mode cannot be switched off from SQL" {
    const url = testing.environ.getPosix("ZETTA_TEST_PG_URL") orelse return error.SkipZigTest;
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var diag: Diagnostic = .{};
    const target = try dsn.parse(arena, url);
    const rw = try open(testing.allocator, testing.io, target, .{}, &diag);
    defer rw.deinit();
    // One connection, so every request below reuses whatever the one before it left behind.
    const ro = try open(testing.allocator, testing.io, target, .{ .read_only = true, .pool_size = 1 }, &diag);
    defer ro.deinit();

    var rand: [4]u8 = undefined;
    testing.io.random(&rand);
    const t = try std.fmt.allocPrint(arena, "zetta_ro_{x}", .{std.mem.readInt(u32, &rand, .little)});
    try exec(rw, try std.fmt.allocPrint(arena, "create table {s} (x integer)", .{t}));
    defer exec(rw, std.fmt.allocPrint(arena, "drop table {s}", .{t}) catch unreachable) catch {};
    const insert = try std.fmt.allocPrint(arena, "insert into {s} values (1)", .{t});

    const attempts = [_][]const u8{
        try std.fmt.allocPrint(arena, "begin read write; {s}; commit", .{insert}),
        try std.fmt.allocPrint(arena, "set default_transaction_read_only = off; {s}", .{insert}),
        try std.fmt.allocPrint(arena, "do $$ begin perform set_config('default_transaction_read_only', 'off', false); commit; {s}; end $$", .{insert}),
        try std.fmt.allocPrint(arena, "/* hidden */ ; call nothing_{s}()", .{t}),
        // Postgres ends a line comment at a carriage return too.
        try std.fmt.allocPrint(arena, "--\rdo $$ begin perform set_config('default_transaction_read_only', 'off', false); commit; {s}; end $$", .{insert}),
    };
    for (attempts) |sql| {
        if (ro.query(arena, sql, .{}, &diag)) |_| {
            std.debug.print("ran in read-only mode: {s}\n", .{sql});
            return error.TestUnexpectedResult;
        } else |_| {}
    }

    // A setting changed by one request is gone by the next, even through set_config().
    _ = try ro.query(arena, "set default_transaction_read_only = off", .{}, &diag);
    try testing.expectError(error.ReadOnly, ro.query(arena, insert, .{}, &diag));
    _ = try ro.query(arena, "select set_config('default_transaction_read_only', 'off', false)", .{}, &diag);
    try testing.expectError(error.ReadOnly, ro.query(arena, insert, .{}, &diag));
    _ = try ro.query(arena, "set session characteristics as transaction read write", .{}, &diag);
    try testing.expectError(error.ReadOnly, ro.query(arena, insert, .{}, &diag));
    const via_filter = "set_config('default_transaction_read_only', 'off', false) is not null";
    _ = try ro.count(arena, .{ .table = .{ .schema = "public", .table = t }, .filter = via_filter }, &diag);
    try testing.expectError(error.ReadOnly, ro.query(arena, insert, .{}, &diag));

    const res = try rw.query(arena, try std.fmt.allocPrint(arena, "select count(*) from {s}", .{t}), .{}, &diag);
    try testing.expectEqualStrings("0", res.rows[0][0].?);
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
