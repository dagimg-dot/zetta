//! Test oracle only: Postgres through libpq, for comparing the native driver
//! against (see ../../oracle.zig). Never part of the zetta binary.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Adapter = @import("../../Adapter.zig");
const Diagnostic = @import("../../Diagnostic.zig");
const types = @import("../../types.zig");
const Pool = @import("../../pool.zig").Pool;
const Conn = @import("Conn.zig");
const sql = @import("sql.zig");
const c = @import("c.zig").c;

const Postgres = @This();

gpa: Allocator,
conninfo: [:0]u8,
pool: Pool(Conn),
database: []u8,
read_only: bool,

/// Connects once up front so a bad DSN fails at startup, not on first use.
pub fn open(gpa: Allocator, io: Io, conninfo: []const u8, options: types.OpenOptions, diag: *Diagnostic) types.Error!*Postgres {
    const self = try gpa.create(Postgres);
    errdefer gpa.destroy(self);
    const owned = try gpa.dupeZ(u8, conninfo);
    errdefer gpa.free(owned);
    var pool: Pool(Conn) = try .init(gpa, io, .{ .conninfo = owned, .read_only = options.read_only }, @max(options.pool_size, 1));
    errdefer pool.deinit(gpa);

    self.* = .{ .gpa = gpa, .conninfo = owned, .pool = pool, .database = &.{}, .read_only = options.read_only };
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    self.database = try gpa.dupe(u8, lease.conn.database());
    return self;
}

pub fn adapter(self: *Postgres) Adapter {
    return .{ .ptr = self, .vtable = &vtable };
}

const vtable: Adapter.VTable = .{
    .info = info,
    .catalog = catalog,
    .columns = columns,
    .detail = detail,
    .function = function,
    .functions = listFunctions,
    .count = count,
    .browse = browse,
    .query = query,
    .deinit = deinit,
};

fn from(ptr: *anyopaque) *Postgres {
    return @ptrCast(@alignCast(ptr));
}

fn deinit(ptr: *anyopaque) void {
    const self = from(ptr);
    const gpa = self.gpa;
    self.pool.deinit(gpa);
    gpa.free(self.database);
    gpa.free(self.conninfo);
    gpa.destroy(self);
}

fn info(ptr: *anyopaque) Adapter.Info {
    const self = from(ptr);
    return .{
        .name = .postgres,
        .database = self.database,
        .read_only = self.read_only,
        .capabilities = .{ .schemas = true, .approx_rows = true },
        .dialect = &@import("../../postgres/dialect.zig").dialect,
    };
}

fn catalog(ptr: *anyopaque, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const res = try lease.conn.exec(sql.catalog, &.{}, diag);
    defer c.PQclear(res);

    var schemas: std.ArrayList(types.Schema) = .empty;
    var tables: std.ArrayList(types.Table) = .empty;
    var current: ?[]const u8 = null;
    for (0..rowCount(res)) |r| {
        const schema = value(res, r, 0).?;
        if (current == null or !std.mem.eql(u8, current.?, schema)) {
            if (current) |name| try schemas.append(arena, .{ .name = name, .tables = try tables.toOwnedSlice(arena) });
            current = try arena.dupe(u8, schema);
        }
        const name = value(res, r, 1) orelse continue;
        try tables.append(arena, .{
            .name = try arena.dupe(u8, name),
            .kind = tableKind(value(res, r, 2).?),
            .approx_rows = if (value(res, r, 3)) |v| std.fmt.parseInt(u64, v, 10) catch null else null,
        });
    }
    if (current) |name| try schemas.append(arena, .{ .name = name, .tables = try tables.toOwnedSlice(arena) });
    return .{ .schemas = try schemas.toOwnedSlice(arena) };
}

fn tableKind(relkind: []const u8) types.TableKind {
    return switch (relkind[0]) {
        'v' => .view,
        'm' => .materialized_view,
        'f' => .foreign_table,
        else => .table,
    };
}

fn columns(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error![]const types.Column {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const params = [_][:0]const u8{ try arena.dupeZ(u8, table.schema), try arena.dupeZ(u8, table.table) };
    const res = try lease.conn.exec(sql.columns, &params, diag);
    defer c.PQclear(res);

    const n = rowCount(res);
    if (n == 0) {
        diag.print("no table named {s}.{s}", .{ table.schema, table.table });
        return error.NotFound;
    }
    const out = try arena.alloc(types.Column, n);
    for (out, 0..) |*col, r| {
        col.* = .{
            .name = try arena.dupe(u8, value(res, r, 0).?),
            .type_name = try arena.dupe(u8, value(res, r, 1).?),
            .nullable = isTrue(value(res, r, 2)),
            .primary_key = isTrue(value(res, r, 3)),
            .default = if (value(res, r, 4)) |d| try arena.dupe(u8, d) else null,
        };
    }
    return out;
}

fn detail(_: *anyopaque, _: Allocator, _: types.TableRef, diag: *Diagnostic) types.Error!types.TableDetail {
    diag.set("table detail is not implemented in the libpq oracle");
    return error.NotFound;
}

fn function(_: *anyopaque, _: Allocator, _: types.FunctionRef, diag: *Diagnostic) types.Error!types.FunctionDetail {
    diag.set("function detail is not implemented in the libpq oracle");
    return error.NotFound;
}

fn listFunctions(_: *anyopaque, _: Allocator, diag: *Diagnostic) types.Error![]const types.Function {
    diag.set("listing functions is not implemented in the libpq oracle");
    return error.NotFound;
}

fn count(_: *anyopaque, _: Allocator, _: types.CountRequest, diag: *Diagnostic) types.Error!u64 {
    diag.set("row counting is not implemented in the libpq oracle");
    return error.NotFound;
}

fn browse(ptr: *anyopaque, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    w.print("select * from {s}.{s}", .{
        try lease.conn.quoteIdent(arena, req.table.schema, diag),
        try lease.conn.quoteIdent(arena, req.table.table, diag),
    }) catch return error.OutOfMemory;
    if (req.filter) |f| if (f.len > 0) w.print(" where {s}", .{f}) catch return error.OutOfMemory;
    if (req.order) |o| if (o.len > 0) w.print(" order by {s}", .{o}) catch return error.OutOfMemory;
    w.print(" limit {d} offset {d}", .{ req.limit, req.offset }) catch return error.OutOfMemory;

    const res = try lease.conn.exec(try text.toOwnedSliceSentinel(0), &.{}, diag);
    defer c.PQclear(res);
    return resultSet(arena, lease.conn, res, req.limit, diag);
}

fn query(ptr: *anyopaque, arena: Allocator, text: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const res = try lease.conn.exec(try arena.dupeZ(u8, text), &.{}, diag);
    defer c.PQclear(res);
    return resultSet(arena, lease.conn, res, options.max_rows, diag);
}

fn resultSet(arena: Allocator, conn: *Conn, res: *c.PGresult, max_rows: usize, diag: *Diagnostic) types.Error!types.ResultSet {
    const ncols: usize = @intCast(c.PQnfields(res));
    const total = rowCount(res);
    const shown = @min(total, max_rows);

    const cols = try arena.alloc(types.ResultColumn, ncols);
    for (cols, 0..) |*col, k| {
        col.* = .{
            .name = try arena.dupe(u8, std.mem.span(c.PQfname(res, @intCast(k)))),
            .type_name = try typeName(arena, conn, c.PQftype(res, @intCast(k)), diag),
        };
    }

    const rows = try arena.alloc(types.Row, shown);
    for (rows, 0..) |*row, r| {
        const cells = try arena.alloc(?[]const u8, ncols);
        for (cells, 0..) |*cell, k| cell.* = if (value(res, r, k)) |v| try arena.dupe(u8, v) else null;
        row.* = cells;
    }

    const affected = std.mem.span(c.PQcmdTuples(res));
    return .{
        .columns = cols,
        .rows = rows,
        .row_count = if (c.PQresultStatus(res) == c.PGRES_TUPLES_OK) total else std.fmt.parseInt(u64, affected, 10) catch 0,
        .truncated = total > shown,
        .command = try arena.dupe(u8, std.mem.span(c.PQcmdStatus(res))),
    };
}

fn typeName(arena: Allocator, conn: *Conn, oid: c.Oid, diag: *Diagnostic) types.Error![]const u8 {
    if (sql.builtinTypeName(oid)) |name| return name;
    var buf: [16]u8 = undefined;
    const oid_text = std.fmt.bufPrintZ(&buf, "{d}", .{oid}) catch unreachable;
    const res = try conn.exec(sql.type_name_lookup, &.{oid_text}, diag);
    defer c.PQclear(res);
    return arena.dupe(u8, value(res, 0, 0) orelse "unknown");
}

fn rowCount(res: *c.PGresult) usize {
    return @intCast(c.PQntuples(res));
}

fn value(res: *c.PGresult, row: usize, col: usize) ?[]const u8 {
    const r: c_int = @intCast(row);
    const k: c_int = @intCast(col);
    if (c.PQgetisnull(res, r, k) == 1) return null;
    const len: usize = @intCast(c.PQgetlength(res, r, k));
    return c.PQgetvalue(res, r, k)[0..len];
}

fn isTrue(v: ?[]const u8) bool {
    return if (v) |s| s.len > 0 and s[0] == 't' else false;
}
