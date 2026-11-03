//! Database access behind one interface. Knows nothing about HTTP or the CLI.

const types = @import("types.zig");

pub const Adapter = @import("Adapter.zig");
pub const Diagnostic = @import("Diagnostic.zig");
pub const dsn = @import("dsn.zig");
pub const open = @import("open.zig").open;

pub const Error = types.Error;
pub const OpenOptions = types.OpenOptions;
pub const Catalog = types.Catalog;
pub const Schema = types.Schema;
pub const Table = types.Table;
pub const TableKind = types.TableKind;
pub const TableRef = types.TableRef;
pub const Column = types.Column;
pub const ResultColumn = types.ResultColumn;
pub const ResultSet = types.ResultSet;
pub const Row = types.Row;
pub const BrowseRequest = types.BrowseRequest;
pub const QueryOptions = types.QueryOptions;
pub const Capabilities = types.Capabilities;

test {
    _ = @import("Diagnostic.zig");
    _ = @import("dsn.zig");
    _ = @import("pool.zig");
    _ = @import("sqlite/Conn.zig");
    _ = @import("sqlite/Sqlite.zig");
    _ = @import("postgres/conninfo.zig");
    _ = @import("postgres/settings.zig");
    _ = @import("postgres/auth.zig");
    _ = @import("postgres/wire.zig");
    _ = @import("postgres/Postgres.zig");
    _ = @import("conformance.zig");
}
