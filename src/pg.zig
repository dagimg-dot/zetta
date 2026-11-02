//! Thin libpq wrapper. Everything comes back in text format; the UI treats
//! values as strings and NULL as JSON null.

const std = @import("std");
const c = @cImport(@cInclude("libpq-fe.h"));

pub const Conn = struct {
    raw: *c.PGconn,

    /// Returns null and fills `err` with a copy of libpq's message on failure.
    pub fn open(gpa: std.mem.Allocator, url: [:0]const u8, err: *[]u8) !?Conn {
        const raw = c.PQconnectdb(url.ptr) orelse return error.OutOfMemory;
        if (c.PQstatus(raw) != c.CONNECTION_OK) {
            err.* = try gpa.dupe(u8, std.mem.trimEnd(u8, std.mem.span(c.PQerrorMessage(raw)), "\n"));
            c.PQfinish(raw);
            return null;
        }
        return .{ .raw = raw };
    }

    pub fn close(self: Conn) void {
        c.PQfinish(self.raw);
    }

    pub fn exec(self: Conn, gpa: std.mem.Allocator, sql: [:0]const u8) !Outcome {
        const res = c.PQexec(self.raw, sql.ptr) orelse return error.OutOfMemory;
        switch (c.PQresultStatus(res)) {
            c.PGRES_COMMAND_OK, c.PGRES_TUPLES_OK => return .{ .ok = .{ .raw = res } },
            else => {
                defer c.PQclear(res);
                const msg = std.mem.trimEnd(u8, std.mem.span(c.PQresultErrorMessage(res)), "\n");
                return .{ .err = try gpa.dupe(u8, msg) };
            },
        }
    }

    /// Quoted identifier, e.g. `public` -> `"public"`.
    pub fn quoteIdent(self: Conn, gpa: std.mem.Allocator, ident: []const u8) ![]u8 {
        const q = c.PQescapeIdentifier(self.raw, ident.ptr, ident.len) orelse return error.BadIdentifier;
        defer c.PQfreemem(q);
        return gpa.dupe(u8, std.mem.span(q));
    }
};

pub const Outcome = union(enum) {
    ok: Result,
    err: []u8,
};

pub const Result = struct {
    raw: *c.PGresult,

    pub fn deinit(self: Result) void {
        c.PQclear(self.raw);
    }

    pub fn rowCount(self: Result) usize {
        return @intCast(c.PQntuples(self.raw));
    }

    pub fn colCount(self: Result) usize {
        return @intCast(c.PQnfields(self.raw));
    }

    pub fn colName(self: Result, col: usize) []const u8 {
        return std.mem.span(c.PQfname(self.raw, @intCast(col)));
    }

    pub fn value(self: Result, row: usize, col: usize) ?[]const u8 {
        const r: c_int = @intCast(row);
        const k: c_int = @intCast(col);
        if (c.PQgetisnull(self.raw, r, k) == 1) return null;
        const len: usize = @intCast(c.PQgetlength(self.raw, r, k));
        return c.PQgetvalue(self.raw, r, k)[0..len];
    }

    pub fn command(self: Result) []const u8 {
        return std.mem.span(c.PQcmdStatus(self.raw));
    }
};
