//! Differential tests: every query goes through the native Postgres adapter and
//! through libpq, and the two results must match byte for byte. Built only with
//! -Dpg-oracle=true and run against ZETTA_TEST_PG_URL.

const std = @import("std");
const testing = std.testing;
const Adapter = @import("Adapter.zig");
const Diagnostic = @import("Diagnostic.zig");
const types = @import("types.zig");
const Native = @import("postgres/Postgres.zig");
const Libpq = @import("oracle/libpq/Postgres.zig");

const setup =
    \\drop schema if exists zetta_oracle cascade;
    \\create schema zetta_oracle;
    \\create type zetta_oracle.mood as enum ('sad', 'ok', 'happy');
    \\create domain zetta_oracle.posint as integer check (value > 0);
    \\create type zetta_oracle.pair as (n integer, s text);
    \\create table zetta_oracle.u (id integer primary key, email text unique);
;

const Case = struct {
    name: []const u8,
    sql: []const u8,
    max_rows: usize = 5000,
};

const cases = [_]Case{
    .{ .name = "nulls and strings", .sql = "select 1 as a, null as b, '' as c, 'x''y' as d, E'line1\\nline2\\ttab' as e, 'héllo ሀይሉ 😀' as f" },
    .{ .name = "integers and decimals", .sql = "select 1::int2, 2::int4, 3::int8, 1.50::numeric(10,2), 'NaN'::numeric, 123456789012345678901234567890.123::numeric" },
    .{ .name = "floats", .sql = "select 1.5::float4, 0.1::float8, 'Infinity'::float8, '-Infinity'::float4, 'NaN'::float8, '-0'::float8, 1e300::float8" },
    .{ .name = "money and booleans", .sql = "select 12.34::money, true, false, null::bool" },
    .{ .name = "character types", .sql = "select 'abc'::varchar(5), 'a'::char(3), 'name'::name, 'x'::\"char\"" },
    .{ .name = "a 100 KB value", .sql = "select repeat('z', 100000) as big, length(repeat('z', 100000))" },
    .{ .name = "bytea", .sql = "select '\\xdeadbeef'::bytea, ''::bytea, decode('00ff', 'hex')" },
    .{ .name = "date and time", .sql = "select date '2024-02-29', time '13:45:00.123', timetz '13:45+03', timestamp '2024-01-01 00:00:00', timestamptz '2024-01-01 00:00:00+00', interval '1 year 2 mons 3 days 04:05:06'" },
    .{ .name = "uuid and json", .sql = "select 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, '{\"a\":[1,2]}'::json, '{\"b\": 2, \"a\": 1}'::jsonb, 'null'::jsonb" },
    .{ .name = "arrays", .sql = "select array[1,2,null]::int[], array['a', null, 'b\"c', 'd,e']::text[], '{{1,2},{3,4}}'::int[], '{}'::text[]" },
    .{ .name = "network and bits", .sql = "select inet '10.0.0.1/8', cidr '10.0.0.0/8', macaddr '08:00:2b:01:02:03', B'101'::bit(3), B'1'::varbit" },
    .{ .name = "types outside the built-in table", .sql = "select point '(1,2)', box '((0,0),(1,1))', circle '<(0,0),1>', int4range(1,5), 'a fat cat'::tsvector, 'oid'::regtype" },
    .{ .name = "enums, domains and composites", .sql = "select 'ok'::zetta_oracle.mood, 5::zetta_oracle.posint, row(1,'a')::zetta_oracle.pair, array['sad','happy']::zetta_oracle.mood[]" },
    .{ .name = "several statements return the last", .sql = "select 1; select 2 as two, 'x' as three" },
    .{ .name = "writes report their tags", .sql = "create temp table t (x int); insert into t values (1), (2), (3); update t set x = x + 1 where x > 1; delete from t where x = 3" },
    .{ .name = "insert returning", .sql = "create temp table r (id serial, v text); insert into r (v) values ('a'), ('b') returning id, v" },
    .{ .name = "utility commands", .sql = "set work_mem = '8MB'; show work_mem" },
    .{ .name = "a transaction left open", .sql = "begin; select 1 as inside" },
    // Two statements keep this on the simple protocol, where statement_timestamp() is the time of
    // the whole message; the extended protocol stamps each of its messages anew.
    .{ .name = "the next request is not inside it", .sql = "select 1; select now() = statement_timestamp() as fresh" },
    .{ .name = "a big result is truncated but counted", .sql = "select g, md5(g::text) from generate_series(1, 20000) g", .max_rows = 5000 },
    .{ .name = "an empty result keeps its columns", .sql = "select 1 as a where false" },
    .{ .name = "the catalog query", .sql = @import("postgres/sql.zig").catalog },
    .{ .name = "a syntax error points at its line", .sql = "select 1;\nselec 2" },
    .{ .name = "a runtime error", .sql = "select 1/0" },
    .{ .name = "a missing table", .sql = "select * from zetta_oracle.nope" },
    .{ .name = "a constraint error has detail", .sql = "insert into zetta_oracle.u values (1, 'a'), (1, 'b')" },
    .{ .name = "a domain check", .sql = "select (-1)::zetta_oracle.posint" },
    .{ .name = "an exception with a hint and context", .sql = "do $$ begin raise exception 'boom' using hint = 'try again'; end $$" },
    .{ .name = "a notice does not leak into the result", .sql = "do $$ begin raise notice 'hello'; end $$; select 'after' as x" },
};

fn openBoth(url: []const u8, native: *Adapter, libpq: *Adapter) !void {
    var diag: Diagnostic = .{};
    native.* = (Native.open(testing.allocator, testing.io, url, .{ .pool_size = 1 }, &diag) catch |err| {
        std.debug.print("native connect failed: {s}\n", .{diag.message()});
        return err;
    }).adapter();
    libpq.* = (Libpq.open(testing.allocator, testing.io, url, .{ .pool_size = 1 }, &diag) catch |err| {
        std.debug.print("libpq connect failed: {s}\n", .{diag.message()});
        return err;
    }).adapter();
}

const Outcome = union(enum) {
    ok: types.ResultSet,
    err: struct { kind: types.Error, message: []const u8 },
};

fn runOne(a: Adapter, arena: std.mem.Allocator, case: Case, exact_count: bool, rollback_after: bool) !Outcome {
    var diag: Diagnostic = .{};
    // The native adapter ends any transaction a request leaves open; give libpq the same rule.
    defer if (rollback_after) {
        var scratch: Diagnostic = .{};
        _ = a.query(arena, "rollback", .{}, &scratch) catch {};
    };
    const res = a.query(arena, case.sql, .{ .max_rows = case.max_rows, .exact_count = exact_count }, &diag) catch |err| {
        return .{ .err = .{ .kind = err, .message = try arena.dupe(u8, diag.message()) } };
    };
    return .{ .ok = res };
}

fn same(native: Outcome, libpq: Outcome, w: *std.Io.Writer) !bool {
    switch (libpq) {
        .err => |want| {
            if (native != .err) return differ(w, "libpq failed with {t}, native succeeded\n  libpq: {s}", .{ want.kind, want.message });
            const got = native.err;
            if (got.kind != want.kind or !std.mem.eql(u8, got.message, want.message))
                return differ(w, "errors differ\n  libpq ({t}): {s}\n  native ({t}): {s}", .{ want.kind, want.message, got.kind, got.message });
            return true;
        },
        .ok => |want| {
            if (native != .ok) return differ(w, "native failed: {s}", .{native.err.message});
            const got = native.ok;
            if (got.row_count_exact) {
                if (!std.mem.eql(u8, got.command, want.command)) return differ(w, "command: libpq {s}, native {s}", .{ want.command, got.command });
                if (got.row_count != want.row_count) return differ(w, "row count: libpq {d}, native {d}", .{ want.row_count, got.row_count });
                if (got.truncated != want.truncated) return differ(w, "truncated differs", .{});
            } else {
                // Stopped past the row limit: libpq read on, so it can only have counted more.
                if (!got.truncated or !want.truncated or got.row_count > want.row_count)
                    return differ(w, "stopped early with {d} rows, but libpq counted {d}", .{ got.row_count, want.row_count });
            }
            if (got.columns.len != want.columns.len) return differ(w, "column count: libpq {d}, native {d}", .{ want.columns.len, got.columns.len });
            for (want.columns, got.columns, 0..) |wc, gc, i| {
                if (!std.mem.eql(u8, wc.name, gc.name) or !std.mem.eql(u8, wc.type_name, gc.type_name))
                    return differ(w, "column {d}: libpq {s} {s}, native {s} {s}", .{ i, wc.name, wc.type_name, gc.name, gc.type_name });
            }
            if (got.rows.len != want.rows.len) return differ(w, "rows: libpq {d}, native {d}", .{ want.rows.len, got.rows.len });
            for (want.rows, got.rows, 0..) |wr, gr, r| {
                for (wr, gr, 0..) |wv, gv, k| {
                    const equal = if (wv == null or gv == null) wv == null and gv == null else std.mem.eql(u8, wv.?, gv.?);
                    if (!equal) return differ(w, "row {d} column {d}: libpq {?s}, native {?s}", .{ r, k, wv, gv });
                }
            }
            return true;
        },
    }
}

fn differ(w: *std.Io.Writer, comptime fmt: []const u8, args: anytype) !bool {
    try w.print(fmt, args);
    return false;
}

test "the native adapter and libpq return identical results" {
    const url = testing.environ.getPosix("ZETTA_TEST_PG_URL") orelse return error.SkipZigTest;
    var native: Adapter = undefined;
    var libpq: Adapter = undefined;
    try openBoth(url, &native, &libpq);
    defer native.deinit();
    defer libpq.deinit();

    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    _ = native.query(arena_state.allocator(), setup, .{}, &diag) catch |err| {
        std.debug.print("setup failed: {s}\n", .{diag.message()});
        return err;
    };

    var failures: usize = 0;
    for (cases) |case| {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        // Exact counts send caller SQL as given; otherwise one statement goes through the
        // extended protocol, so both paths are held against libpq.
        for ([_]bool{ true, false }) |exact| {
            const a = try runOne(native, arena, case, exact, false);
            const b = try runOne(libpq, arena, case, true, true);
            var buf: [4096]u8 = undefined;
            var w: std.Io.Writer = .fixed(&buf);
            if (!try same(a, b, &w)) {
                std.debug.print("\n[{s}, {s}] {s}\n", .{ case.name, if (exact) "exact" else "stops early", w.buffered() });
                failures += 1;
            }
        }
    }
    _ = native.query(arena_state.allocator(), "drop schema zetta_oracle cascade", .{}, &diag) catch {};
    try testing.expectEqual(0, failures);
}

test "the catalog, columns and browse calls agree too" {
    const url = testing.environ.getPosix("ZETTA_TEST_PG_URL") orelse return error.SkipZigTest;
    var native: Adapter = undefined;
    var libpq: Adapter = undefined;
    try openBoth(url, &native, &libpq);
    defer native.deinit();
    defer libpq.deinit();

    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var diag: Diagnostic = .{};
    _ = try native.query(arena, setup, .{}, &diag);
    defer _ = native.query(arena, "drop schema zetta_oracle cascade", .{}, &diag) catch {};

    const ref: types.TableRef = .{ .schema = "zetta_oracle", .table = "u" };
    const cn = try native.columns(arena, ref, &diag);
    const cl = try libpq.columns(arena, ref, &diag);
    try testing.expectEqual(cl.len, cn.len);
    for (cl, cn) |l, n| {
        try testing.expectEqualStrings(l.name, n.name);
        try testing.expectEqualStrings(l.type_name, n.type_name);
        try testing.expectEqual(l.nullable, n.nullable);
        try testing.expectEqual(l.primary_key, n.primary_key);
    }

    const kn = try native.catalog(arena, &diag);
    const kl = try libpq.catalog(arena, &diag);
    try testing.expectEqual(kl.schemas.len, kn.schemas.len);
    for (kl.schemas, kn.schemas) |l, n| {
        try testing.expectEqualStrings(l.name, n.name);
        try testing.expectEqual(l.tables.len, n.tables.len);
    }
}
