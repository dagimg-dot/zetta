//! SQLite from the vendored amalgamation. Schemas are attached databases.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Adapter = @import("../Adapter.zig");
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Pool = @import("../pool.zig").Pool;
const Conn = @import("Conn.zig");

const Sqlite = @This();

gpa: Allocator,
path: [:0]u8,
pool: Pool(Conn),
database: []const u8,
read_only: bool,

const schemas_sql = "select name from pragma_database_list order by seq";
const columns_sql =
    \\select name, type, "notnull", pk, dflt_value from pragma_table_info(?1, ?2)
;

pub const Target = struct {
    path: []const u8,
    uri: bool,
};

/// Opens one connection up front so a missing file fails at startup.
pub fn open(gpa: Allocator, io: Io, target: Target, options: types.OpenOptions, diag: *Diagnostic) types.Error!*Sqlite {
    const self = try gpa.create(Sqlite);
    errdefer gpa.destroy(self);
    const owned = try gpa.dupeZ(u8, target.path);
    errdefer gpa.free(owned);
    const config: Conn.Config = .{ .path = owned, .uri = target.uri, .read_only = options.read_only };
    // Each connection to ":memory:" would be its own empty database.
    const size = if (std.mem.eql(u8, owned, ":memory:")) 1 else @max(options.pool_size, 1);

    self.* = .{
        .gpa = gpa,
        .path = owned,
        .pool = try .init(gpa, io, config, size),
        .database = displayName(owned, target.uri),
        .read_only = options.read_only,
    };
    errdefer self.pool.deinit(gpa);
    const lease = try self.pool.acquire(diag);
    lease.release();
    return self;
}

fn displayName(path: []const u8, uri: bool) []const u8 {
    var name = path;
    if (uri) {
        name = name["file:".len..];
        if (std.mem.indexOfScalar(u8, name, '?')) |q| name = name[0..q];
    }
    return std.fs.path.basename(name);
}

pub fn adapter(self: *Sqlite) Adapter {
    return .{ .ptr = self, .vtable = &vtable };
}

const vtable: Adapter.VTable = .{
    .info = info,
    .catalog = catalog,
    .columns = columns,
    .browse = browse,
    .query = query,
    .deinit = deinit,
};

fn from(ptr: *anyopaque) *Sqlite {
    return @ptrCast(@alignCast(ptr));
}

fn deinit(ptr: *anyopaque) void {
    const self = from(ptr);
    const gpa = self.gpa;
    self.pool.deinit(gpa);
    gpa.free(self.path);
    gpa.destroy(self);
}

fn info(ptr: *anyopaque) Adapter.Info {
    const self = from(ptr);
    return .{
        .name = .sqlite,
        .database = self.database,
        .read_only = self.read_only,
        .capabilities = .{ .schemas = true, .approx_rows = false },
    };
}

fn catalog(ptr: *anyopaque, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    const names = try lease.conn.runAll(arena, schemas_sql, std.math.maxInt(usize), diag);
    const schemas = try arena.alloc(types.Schema, names.rows.len);
    for (schemas, names.rows) |*schema, row| {
        const name = row[0].?;
        const text = try std.fmt.allocPrint(arena,
            \\select name, type from {s}.sqlite_schema
            \\where type in ('table', 'view') and name not like 'sqlite\_%' escape '\'
            \\order by name
        , .{try Conn.quoteIdent(arena, name)});
        const res = try lease.conn.runAll(arena, text, std.math.maxInt(usize), diag);
        const tables = try arena.alloc(types.Table, res.rows.len);
        for (tables, res.rows) |*table, t| {
            table.* = .{
                .name = t[0].?,
                .kind = if (std.mem.eql(u8, t[1].?, "view")) .view else .table,
                .approx_rows = null,
            };
        }
        schema.* = .{ .name = name, .tables = tables };
    }
    return .{ .schemas = schemas };
}

fn columns(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error![]const types.Column {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    const res = try lease.conn.runBound(arena, columns_sql, &.{ table.table, table.schema }, diag);
    if (res.rows.len == 0) {
        diag.print("no table named {s}.{s}", .{ table.schema, table.table });
        return error.NotFound;
    }
    const out = try arena.alloc(types.Column, res.rows.len);
    for (out, res.rows) |*col, row| {
        col.* = .{
            .name = row[0].?,
            .type_name = try std.ascii.allocLowerString(arena, row[1] orelse ""),
            .nullable = std.mem.eql(u8, row[2].?, "0"),
            .primary_key = !std.mem.eql(u8, row[3].?, "0"),
            .default = row[4],
        };
    }
    return out;
}

fn browse(ptr: *anyopaque, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    w.print("select * from {s}.{s}", .{
        try Conn.quoteIdent(arena, req.table.schema),
        try Conn.quoteIdent(arena, req.table.table),
    }) catch return error.OutOfMemory;
    if (req.filter) |f| if (f.len > 0) w.print(" where {s}", .{f}) catch return error.OutOfMemory;
    if (req.order) |o| if (o.len > 0) w.print(" order by {s}", .{o}) catch return error.OutOfMemory;
    w.print(" limit {d} offset {d}", .{ req.limit, req.offset }) catch return error.OutOfMemory;
    return lease.conn.runAll(arena, text.written(), req.limit, diag);
}

fn query(ptr: *anyopaque, arena: Allocator, text: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    return lease.conn.runAll(arena, text, options.max_rows, diag);
}

test "display name drops the directory and URI parameters" {
    try std.testing.expectEqualStrings("app.db", displayName("/srv/data/app.db", false));
    try std.testing.expectEqualStrings("conf", displayName("file:conf?mode=memory&cache=shared", true));
}
