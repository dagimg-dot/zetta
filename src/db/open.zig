//! The only file that names concrete adapters.

const std = @import("std");
const Adapter = @import("Adapter.zig");
const Diagnostic = @import("Diagnostic.zig");
const types = @import("types.zig");
const Dsn = @import("dsn.zig").Dsn;
const Postgres = @import("postgres/Postgres.zig");
const Sqlite = @import("sqlite/Sqlite.zig");

pub fn open(gpa: std.mem.Allocator, io: std.Io, dsn: Dsn, options: types.OpenOptions, diag: *Diagnostic) types.Error!Adapter {
    return switch (dsn) {
        .postgres => |conninfo| (try Postgres.open(gpa, io, conninfo, options, diag)).adapter(),
        .sqlite => |s| (try Sqlite.open(gpa, io, .{ .path = s.path, .uri = s.uri }, options, diag)).adapter(),
    };
}
