//! Values every adapter produces. All slices are owned by the allocator the
//! caller passed in, which is expected to be an arena.

pub const Error = error{
    ConnectFailed,
    QueryFailed,
    ReadOnly,
    NotFound,
    OutOfMemory,
};

pub const TableKind = enum { table, view, materialized_view, foreign_table };

pub const Table = struct {
    name: []const u8,
    kind: TableKind,
    approx_rows: ?u64,
};

pub const Schema = struct {
    name: []const u8,
    tables: []const Table,
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
    /// when `truncated` is set.
    row_count: u64,
    truncated: bool,
    command: []const u8,

    pub const empty: ResultSet = .{ .columns = &.{}, .rows = &.{}, .row_count = 0, .truncated = false, .command = "" };
};

pub const BrowseRequest = struct {
    table: TableRef,
    /// Raw SQL placed after WHERE.
    filter: ?[]const u8 = null,
    /// Raw SQL placed after ORDER BY.
    order: ?[]const u8 = null,
    limit: u32 = 100,
    offset: u64 = 0,
};

pub const QueryOptions = struct {
    max_rows: usize = 5000,
};

pub const OpenOptions = struct {
    read_only: bool = false,
    pool_size: usize = 4,
};

pub const Capabilities = struct {
    schemas: bool,
    approx_rows: bool,
};
