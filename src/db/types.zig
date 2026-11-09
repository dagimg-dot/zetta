//! Values every adapter produces. All slices are owned by the allocator the
//! caller passed in, which is expected to be an arena.

const std = @import("std");
const Builder = @import("builder.zig").Builder;

pub const Error = error{
    ConnectFailed,
    QueryFailed,
    ReadOnly,
    NotFound,
    /// The statement ran past the budget its caller gave it.
    Timeout,
    OutOfMemory,
};

pub const TableKind = enum { table, view, materialized_view, foreign_table };

pub const Table = struct {
    name: []const u8,
    kind: TableKind,
    approx_rows: ?u64,
};

pub const FunctionKind = enum { function, procedure, aggregate, window };

pub const Function = struct {
    name: []const u8,
    kind: FunctionKind,
    /// The arguments that tell overloads apart, as text. Empty for none.
    arguments: []const u8,
    /// Null for a procedure, or where the database does not say, as in SQLite.
    returns: ?[]const u8,
};

pub const Schema = struct {
    name: []const u8,
    tables: []const Table,
    /// What the database's users defined; never built-ins or extension members.
    functions: []const Function = &.{},
};

pub const Catalog = struct {
    schemas: []const Schema,
};

pub const TableRef = struct {
    schema: []const u8,
    table: []const u8,
};

pub const Column = struct {
    name: []const u8,
    type_name: []const u8,
    nullable: bool,
    primary_key: bool,
    default: ?[]const u8,
    comment: ?[]const u8 = null,
};

pub const ConstraintKind = enum { primary_key, unique, check, foreign_key, exclusion };

pub const Constraint = struct {
    name: []const u8,
    kind: ConstraintKind,
    columns: []const []const u8,
    definition: []const u8,
};

pub const Index = struct {
    name: []const u8,
    /// Column names, or expressions as text.
    columns: []const []const u8,
    unique: bool,
    primary: bool,
    method: []const u8,
    predicate: ?[]const u8,
    /// Null for an index the database made itself and never wrote SQL for.
    definition: ?[]const u8,
    size_bytes: ?u64,
    scans: ?u64,
};

pub const FkAction = enum {
    no_action,
    restrict,
    cascade,
    set_null,
    set_default,

    pub fn text(a: FkAction) []const u8 {
        return switch (a) {
            .no_action => "NO ACTION",
            .restrict => "RESTRICT",
            .cascade => "CASCADE",
            .set_null => "SET NULL",
            .set_default => "SET DEFAULT",
        };
    }

    /// Parses the spelling `text` returns, ignoring case.
    pub fn parse(s: []const u8) ?FkAction {
        inline for (@typeInfo(FkAction).@"enum".fields) |f| {
            const a: FkAction = @enumFromInt(f.value);
            if (@import("std").ascii.eqlIgnoreCase(s, a.text())) return a;
        }
        return null;
    }
};

/// A reference from this table to another.
pub const ForeignKey = struct {
    name: []const u8,
    columns: []const []const u8,
    ref_schema: []const u8,
    ref_table: []const u8,
    ref_columns: []const []const u8,
    on_update: FkAction,
    on_delete: FkAction,
};

/// A reference from another table to this one.
pub const Reference = struct {
    name: []const u8,
    schema: []const u8,
    table: []const u8,
    columns: []const []const u8,
    ref_columns: []const []const u8,
    on_update: FkAction,
    on_delete: FkAction,
};

pub const TriggerTiming = enum {
    before,
    after,
    instead_of,

    pub fn text(t: TriggerTiming) []const u8 {
        return switch (t) {
            .before => "BEFORE",
            .after => "AFTER",
            .instead_of => "INSTEAD OF",
        };
    }
};

pub const TriggerEvent = enum {
    insert,
    update,
    delete,
    truncate,

    pub fn text(e: TriggerEvent) []const u8 {
        return switch (e) {
            .insert => "INSERT",
            .update => "UPDATE",
            .delete => "DELETE",
            .truncate => "TRUNCATE",
        };
    }
};

pub const TriggerLevel = enum {
    row,
    statement,

    pub fn text(l: TriggerLevel) []const u8 {
        return switch (l) {
            .row => "ROW",
            .statement => "STATEMENT",
        };
    }
};

pub const Trigger = struct {
    name: []const u8,
    timing: TriggerTiming,
    events: []const TriggerEvent,
    level: TriggerLevel,
    function: ?[]const u8,
    definition: []const u8,
    enabled: bool,
};

pub const Sizes = struct {
    total: u64,
    table: u64,
    indexes: u64,
};

/// Everything about one table or view except its rows.
pub const TableDetail = struct {
    schema: []const u8,
    name: []const u8,
    kind: TableKind,
    approx_rows: ?u64,
    size_bytes: ?Sizes,
    comment: ?[]const u8,
    columns: []const Column,
    constraints: []const Constraint,
    indexes: []const Index,
    foreign_keys: []const ForeignKey,
    referenced_by: []const Reference,
    triggers: []const Trigger,
    /// The statements that would create the object.
    ddl: []const u8,
};

pub const FunctionRef = struct {
    schema: []const u8,
    name: []const u8,
    /// As `Function.arguments`.
    arguments: []const u8,
};

pub const Volatility = enum { immutable, stable, @"volatile" };

/// Everything about one function or procedure.
pub const FunctionDetail = struct {
    schema: []const u8,
    name: []const u8,
    kind: FunctionKind,
    arguments: []const u8,
    /// The full argument list, with modes and defaults.
    signature: []const u8,
    returns: ?[]const u8,
    language: []const u8,
    volatility: Volatility,
    strict: bool,
    security_definer: bool,
    owner: []const u8,
    comment: ?[]const u8,
    /// The statement that would create it. Null for an aggregate, which has no single one.
    definition: ?[]const u8,
    /// A statement that calls it, with its arguments in a comment to fill in. Null when only
    /// the database can call it, as with a trigger function.
    call: ?[]const u8,
};

pub const ResultColumn = struct {
    name: []const u8,
    type_name: []const u8,
};

pub const Row = []const ?[]const u8;

pub const ResultSet = struct {
    columns: []const ResultColumn,
    rows: []const Row,
    /// Rows the statement produced, or rows it changed. Can exceed `rows.len`
    /// when `truncated` is set, and is only a lower bound when `row_count_exact` is not.
    row_count: u64,
    truncated: bool,
    /// What stopped `rows` short of `row_count`, when `truncated` is set.
    truncated_by: Limit = .rows,
    /// False when reading stopped one row past the row limit, so more rows may exist.
    row_count_exact: bool = true,
    command: []const u8,

    pub const Limit = enum { rows, bytes };

    pub const empty: ResultSet = .{ .columns = &.{}, .rows = &.{}, .row_count = 0, .truncated = false, .command = "" };
};

/// How much of a result an adapter keeps. Every row past them is still read, but not stored.
pub const Limits = struct {
    max_rows: usize = std.math.maxInt(usize),
    /// Cell bytes stored across the request's results. The row that crosses it is kept, so
    /// at least one row always comes back.
    max_bytes: usize = std.math.maxInt(usize),
    /// Reads every row to count them all. When false, reading may stop one row past `max_rows`.
    exact_count: bool = true,
};

pub const default_max_bytes = 64 * 1024 * 1024;

pub const BrowseRequest = struct {
    table: TableRef,
    /// Raw SQL placed after WHERE.
    filter: ?[]const u8 = null,
    /// Raw SQL placed after ORDER BY.
    order: ?[]const u8 = null,
    /// Compiled by the adapter with bound values; ANDed with `filter` and ordered after `order`.
    builder: ?Builder = null,
    limit: u32 = 100,
    offset: u64 = 0,
    /// As in `Limits`.
    max_bytes: usize = default_max_bytes,
    /// Stops the statement with error.Timeout once it runs this long. Null means no limit.
    budget_ms: ?u32 = null,
};

pub const CountRequest = struct {
    table: TableRef,
    /// Raw SQL placed after WHERE, as in `BrowseRequest`.
    filter: ?[]const u8 = null,
    /// Its sorts are ignored; a count has no order.
    builder: ?Builder = null,
    budget_ms: u32 = 3000,
};

pub const QueryOptions = struct {
    max_rows: usize = 5000,
    max_bytes: usize = default_max_bytes,
    /// Off, a single statement stops one row past `max_rows` and its count is a lower bound.
    exact_count: bool = false,
    /// As in `BrowseRequest`. With `exact_count` every row is read to count it, so this is
    /// what bounds a large result.
    budget_ms: ?u32 = null,

    pub fn limits(o: QueryOptions) Limits {
        return .{ .max_rows = o.max_rows, .max_bytes = o.max_bytes, .exact_count = o.exact_count };
    }
};

pub const OpenOptions = struct {
    read_only: bool = false,
    pool_size: usize = 4,
    /// For PG* variables and the password file. Null means the environment is ignored.
    env: ?*const std.process.Environ.Map = null,
};

pub const Capabilities = struct {
    schemas: bool,
    approx_rows: bool,
};
