//! The one interface the rest of zetta sees. Implementations live in
//! `postgres/` and `sqlite/`; only `open.zig` names them.
//!
//! Every method may be called from several threads at once.

const std = @import("std");
const Allocator = std.mem.Allocator;
const types = @import("types.zig");
const Diagnostic = @import("Diagnostic.zig");
const builder = @import("builder.zig");

const Adapter = @This();

ptr: *anyopaque,
vtable: *const VTable,

pub const Name = enum { postgres, sqlite };

pub const Info = struct {
    name: Name,
    /// Database name, or the file name for SQLite.
    database: []const u8,
    read_only: bool,
    capabilities: types.Capabilities,
    /// How this database spells the filter and sort builder.
    dialect: *const builder.Dialect,
};

pub const VTable = struct {
    info: *const fn (*anyopaque) Info,
    catalog: *const fn (*anyopaque, Allocator, *Diagnostic) types.Error!types.Catalog,
    columns: *const fn (*anyopaque, Allocator, types.TableRef, *Diagnostic) types.Error![]const types.Column,
    detail: *const fn (*anyopaque, Allocator, types.TableRef, *Diagnostic) types.Error!types.TableDetail,
    function: *const fn (*anyopaque, Allocator, types.FunctionRef, *Diagnostic) types.Error!types.FunctionDetail,
    functions: *const fn (*anyopaque, Allocator, *Diagnostic) types.Error![]const types.Function,
    count: *const fn (*anyopaque, Allocator, types.CountRequest, *Diagnostic) types.Error!u64,
    browse: *const fn (*anyopaque, Allocator, types.BrowseRequest, *Diagnostic) types.Error!types.ResultSet,
    query: *const fn (*anyopaque, Allocator, []const u8, types.QueryOptions, *Diagnostic) types.Error!types.ResultSet,
    deinit: *const fn (*anyopaque) void,
};

pub fn info(a: Adapter) Info {
    return a.vtable.info(a.ptr);
}

pub fn catalog(a: Adapter, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    return a.vtable.catalog(a.ptr, arena, diag);
}

pub fn columns(a: Adapter, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error![]const types.Column {
    return a.vtable.columns(a.ptr, arena, table, diag);
}

/// NotFound when no table or view has that name.
pub fn detail(a: Adapter, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error!types.TableDetail {
    return a.vtable.detail(a.ptr, arena, table, diag);
}

/// NotFound when no function has that name and those arguments.
pub fn function(a: Adapter, arena: Allocator, ref: types.FunctionRef, diag: *Diagnostic) types.Error!types.FunctionDetail {
    return a.vtable.function(a.ptr, arena, ref, diag);
}

/// What an expression can call by bare name, built-ins and extensions included, sorted by name in
/// byte order with the fewest arguments first, so overloads are adjacent. Never procedures.
pub fn functions(a: Adapter, arena: Allocator, diag: *Diagnostic) types.Error![]const types.Function {
    return a.vtable.functions(a.ptr, arena, diag);
}

/// The exact number of rows that pass the filter. NotFound for a missing table or view,
/// Timeout when counting runs past `req.budget_ms`.
pub fn count(a: Adapter, arena: Allocator, req: types.CountRequest, diag: *Diagnostic) types.Error!u64 {
    return a.vtable.count(a.ptr, arena, req, diag);
}

pub fn browse(a: Adapter, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    return a.vtable.browse(a.ptr, arena, req, diag);
}

pub fn query(a: Adapter, arena: Allocator, sql: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    return a.vtable.query(a.ptr, arena, sql, options, diag);
}

pub fn deinit(a: Adapter) void {
    a.vtable.deinit(a.ptr);
}
