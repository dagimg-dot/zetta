//! One libpq connection. Used by one thread at a time through the pool.

const std = @import("std");
const c = @import("c.zig").c;
const Diagnostic = @import("../Diagnostic.zig");
const Error = @import("../types.zig").Error;

const Conn = @This();

raw: *c.PGconn,

pub const Config = struct {
    conninfo: [:0]const u8,
    read_only: bool,
};

const sqlstate_read_only = "25006";

pub fn connect(config: Config, diag: *Diagnostic) Error!Conn {
    const raw = c.PQconnectdb(config.conninfo.ptr) orelse return error.OutOfMemory;
    if (c.PQstatus(raw) != c.CONNECTION_OK) {
        diag.set(std.mem.span(c.PQerrorMessage(raw)));
        c.PQfinish(raw);
        return error.ConnectFailed;
    }
    _ = c.PQsetNoticeProcessor(raw, ignoreNotice, null);
    var conn: Conn = .{ .raw = raw };
    if (config.read_only) {
        const res = conn.exec("set default_transaction_read_only = on", &.{}, diag) catch |err| {
            c.PQfinish(raw);
            return if (err == error.OutOfMemory) err else error.ConnectFailed;
        };
        c.PQclear(res);
    }
    return conn;
}

/// libpq prints server notices ("drop cascades to ...") to stderr by default.
fn ignoreNotice(_: ?*anyopaque, _: [*c]const u8) callconv(.c) void {}

pub fn close(self: *Conn) void {
    c.PQfinish(self.raw);
}

pub fn healthy(self: *Conn) bool {
    return c.PQstatus(self.raw) == c.CONNECTION_OK;
}

pub fn database(self: *Conn) []const u8 {
    return std.mem.span(c.PQdb(self.raw));
}

/// With `params` the statement runs alone through PQexecParams. Without,
/// PQexec accepts several statements and returns the last result.
/// The caller frees the result with PQclear.
pub fn exec(self: *Conn, sql: [:0]const u8, params: []const [:0]const u8, diag: *Diagnostic) Error!*c.PGresult {
    var values: [4][*c]const u8 = undefined;
    std.debug.assert(params.len <= values.len);
    for (params, 0..) |p, i| values[i] = p.ptr;

    const maybe = if (params.len == 0)
        c.PQexec(self.raw, sql.ptr)
    else
        c.PQexecParams(self.raw, sql.ptr, @intCast(params.len), null, &values, null, null, 0);
    const res = maybe orelse {
        diag.set(std.mem.span(c.PQerrorMessage(self.raw)));
        return error.QueryFailed;
    };

    switch (c.PQresultStatus(res)) {
        c.PGRES_COMMAND_OK, c.PGRES_TUPLES_OK, c.PGRES_EMPTY_QUERY => return res,
        else => |status| {
            defer c.PQclear(res);
            const msg = std.mem.span(c.PQresultErrorMessage(res));
            if (msg.len > 0) {
                diag.set(msg);
            } else {
                diag.print("unsupported result: {s}", .{std.mem.span(c.PQresStatus(status))});
            }
            const state = c.PQresultErrorField(res, c.PG_DIAG_SQLSTATE);
            if (state != null and std.mem.eql(u8, std.mem.span(state), sqlstate_read_only)) return error.ReadOnly;
            return error.QueryFailed;
        },
    }
}

/// `public` becomes `"public"`, with embedded quotes doubled.
pub fn quoteIdent(self: *Conn, arena: std.mem.Allocator, ident: []const u8, diag: *Diagnostic) Error![]const u8 {
    const quoted = c.PQescapeIdentifier(self.raw, ident.ptr, ident.len) orelse {
        diag.set(std.mem.span(c.PQerrorMessage(self.raw)));
        return error.QueryFailed;
    };
    defer c.PQfreemem(quoted);
    return arena.dupe(u8, std.mem.span(quoted));
}
