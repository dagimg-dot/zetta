//! Postgres over the native wire protocol, behind a small connection pool.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Adapter = @import("../Adapter.zig");
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Pool = @import("../pool.zig").Pool;
const Conn = @import("Conn.zig");
const conninfo = @import("conninfo.zig");
const settings_mod = @import("settings.zig");
const sql = @import("sql.zig");

const Postgres = @This();

gpa: Allocator,
arena_state: std.heap.ArenaAllocator,
settings: settings_mod.Settings,
roots: Conn.Roots = .{},
pool: Pool(PooledConn),
read_only: bool,

/// The pool hands out values; a Conn is already a pointer to its heap state.
const PooledConn = struct {
    conn: Conn,

    pub const Config = Conn.Config;

    pub fn connect(config: Config, diag: *Diagnostic) types.Error!PooledConn {
        return .{ .conn = try Conn.connect(config, diag) };
    }

    pub fn close(self: *PooledConn) void {
        self.conn.close();
    }

    pub fn healthy(self: *PooledConn) bool {
        return self.conn.healthy();
    }
};

/// Connects once up front so a bad DSN fails at startup, not on first use.
pub fn open(gpa: Allocator, io: Io, text: []const u8, options: types.OpenOptions, diag: *Diagnostic) types.Error!*Postgres {
    const self = try gpa.create(Postgres);
    errdefer gpa.destroy(self);
    self.* = .{
        .gpa = gpa,
        .arena_state = .init(gpa),
        .settings = undefined,
        .pool = undefined,
        .read_only = options.read_only,
    };
    errdefer self.arena_state.deinit();
    const arena = self.arena_state.allocator();

    var parse_err: conninfo.ErrorText = .{};
    const cfg = conninfo.parse(arena, text, &parse_err) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidConnInfo => {
            diag.set(parse_err.message());
            return error.ConnectFailed;
        },
    };
    self.settings = settings_mod.resolve(arena, io, cfg, options.env, options.read_only, diag) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidSettings => return error.ConnectFailed,
    };

    self.pool = try .init(gpa, io, .{ .gpa = gpa, .io = io, .settings = &self.settings, .roots = &self.roots }, @max(options.pool_size, 1));
    errdefer self.pool.deinit(gpa);
    errdefer self.roots.deinit(gpa);

    const lease = try self.pool.acquire(diag);
    lease.release();
    return self;
}

pub fn adapter(self: *Postgres) Adapter {
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

fn from(ptr: *anyopaque) *Postgres {
    return @ptrCast(@alignCast(ptr));
}

fn deinit(ptr: *anyopaque) void {
    const self = from(ptr);
    const gpa = self.gpa;
    self.pool.deinit(gpa);
    self.roots.deinit(gpa);
    self.arena_state.deinit();
    gpa.destroy(self);
}

fn info(ptr: *anyopaque) Adapter.Info {
    const self = from(ptr);
    return .{
        .name = .postgres,
        .database = self.settings.dbname,
        .read_only = self.read_only,
        .capabilities = .{ .schemas = true, .approx_rows = true },
    };
}

fn run(self: *Postgres, arena: Allocator, text: []const u8, params: ?[]const Conn.Param, max_rows: usize, diag: *Diagnostic) types.Error!types.ResultSet {
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = &lease.conn.conn;
    defer if (conn.healthy() and conn.inTransaction()) {
        // Each request stands alone: a BEGIN without COMMIT would otherwise hold its
        // locks on a pooled connection and leak into whoever uses it next.
        var scratch: Diagnostic = .{};
        _ = conn.run(arena, "rollback", null, 0, &scratch) catch {};
    };
    return conn.run(arena, text, params, max_rows, diag);
}

fn catalog(ptr: *anyopaque, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    const self = from(ptr);
    const res = try self.run(arena, sql.catalog, null, std.math.maxInt(usize), diag);

    var schemas: std.ArrayList(types.Schema) = .empty;
    var tables: std.ArrayList(types.Table) = .empty;
    var current: ?[]const u8 = null;
    for (res.rows) |row| {
        const schema = row[0].?;
        if (current == null or !std.mem.eql(u8, current.?, schema)) {
            if (current) |name| try schemas.append(arena, .{ .name = name, .tables = try tables.toOwnedSlice(arena) });
            current = schema;
        }
        const name = row[1] orelse continue;
        try tables.append(arena, .{
            .name = name,
            .kind = tableKind(row[2].?),
            .approx_rows = if (row[3]) |v| std.fmt.parseInt(u64, v, 10) catch null else null,
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
    const res = try self.run(arena, sql.columns, &.{ table.schema, table.table }, std.math.maxInt(usize), diag);
    if (res.rows.len == 0) {
        diag.print("no table named {s}.{s}", .{ table.schema, table.table });
        return error.NotFound;
    }
    const out = try arena.alloc(types.Column, res.rows.len);
    for (out, res.rows) |*col, row| {
        col.* = .{
            .name = row[0].?,
            .type_name = row[1].?,
            .nullable = isTrue(row[2]),
            .primary_key = isTrue(row[3]),
            .default = row[4],
        };
    }
    return out;
}

/// `name` becomes `"name"`, with embedded quotes doubled, as PQescapeIdentifier does.
pub fn quoteIdent(arena: Allocator, ident: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, ident.len + 2);
    out.appendAssumeCapacity('"');
    for (ident) |ch| {
        if (ch == '"') try out.append(arena, '"');
        try out.append(arena, ch);
    }
    try out.append(arena, '"');
    return out.items;
}

fn browse(ptr: *anyopaque, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    w.print("select * from {s}.{s}", .{ try quoteIdent(arena, req.table.schema), try quoteIdent(arena, req.table.table) }) catch return error.OutOfMemory;
    if (req.filter) |f| if (f.len > 0) w.print(" where {s}", .{f}) catch return error.OutOfMemory;
    if (req.order) |o| if (o.len > 0) w.print(" order by {s}", .{o}) catch return error.OutOfMemory;
    w.print(" limit {d} offset {d}", .{ req.limit, req.offset }) catch return error.OutOfMemory;
    return self.run(arena, text.written(), null, req.limit, diag);
}

fn query(ptr: *anyopaque, arena: Allocator, text: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    return self.run(arena, text, null, options.max_rows, diag);
}

fn isTrue(v: ?[]const u8) bool {
    return if (v) |s| s.len > 0 and s[0] == 't' else false;
}

test "identifiers are quoted with embedded quotes doubled" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectEqualStrings("\"we\"\"ird\"", try quoteIdent(arena_state.allocator(), "we\"ird"));
}
