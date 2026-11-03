//! A fixed-size connection pool. `Conn` provides `Config`, `connect`,
//! `close` and `healthy`. Connections open lazily and a broken one is
//! replaced on the next acquire.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Diagnostic = @import("Diagnostic.zig");
const Error = @import("types.zig").Error;

pub fn Pool(comptime Conn: type) type {
    return struct {
        const Self = @This();

        io: Io,
        config: Conn.Config,
        mutex: Io.Mutex = .init,
        cond: Io.Condition = .init,
        conns: []?Conn,
        busy: []bool,

        pub const Lease = struct {
            pool: *Self,
            index: usize,
            conn: *Conn,

            /// Returns the connection, closing it first if it went bad.
            pub fn release(l: Lease) void {
                if (!l.conn.healthy()) {
                    l.conn.close();
                    l.pool.conns[l.index] = null;
                }
                l.pool.giveBack(l.index);
            }
        };

        pub fn init(gpa: Allocator, io: Io, config: Conn.Config, size: usize) Allocator.Error!Self {
            const conns = try gpa.alloc(?Conn, size);
            errdefer gpa.free(conns);
            const busy = try gpa.alloc(bool, size);
            @memset(conns, null);
            @memset(busy, false);
            return .{ .io = io, .config = config, .conns = conns, .busy = busy };
        }

        pub fn deinit(self: *Self, gpa: Allocator) void {
            for (self.conns) |*slot| if (slot.*) |*conn| conn.close();
            gpa.free(self.conns);
            gpa.free(self.busy);
        }

        pub fn acquire(self: *Self, diag: *Diagnostic) Error!Lease {
            self.mutex.lockUncancelable(self.io);
            const index = while (true) {
                if (std.mem.indexOfScalar(bool, self.busy, false)) |i| break i;
                self.cond.waitUncancelable(self.io, &self.mutex);
            };
            self.busy[index] = true;
            self.mutex.unlock(self.io);

            if (self.conns[index] == null) {
                self.conns[index] = Conn.connect(self.config, diag) catch |err| {
                    self.giveBack(index);
                    return err;
                };
            }
            return .{ .pool = self, .index = index, .conn = &self.conns[index].? };
        }

        fn giveBack(self: *Self, index: usize) void {
            self.mutex.lockUncancelable(self.io);
            self.busy[index] = false;
            self.mutex.unlock(self.io);
            self.cond.signal(self.io);
        }
    };
}

const FakeConn = struct {
    const Config = struct { fail: bool };
    ok: bool = true,
    var opened: usize = 0;
    var closed: usize = 0;

    fn connect(config: Config, diag: *Diagnostic) Error!FakeConn {
        if (config.fail) {
            diag.set("refused");
            return error.ConnectFailed;
        }
        opened += 1;
        return .{};
    }
    fn close(_: *FakeConn) void {
        closed += 1;
    }
    fn healthy(c: *FakeConn) bool {
        return c.ok;
    }
};

test "connections open lazily and are reused" {
    const gpa = std.testing.allocator;
    FakeConn.opened = 0;
    FakeConn.closed = 0;
    var pool: Pool(FakeConn) = try .init(gpa, std.testing.io, .{ .fail = false }, 2);
    defer pool.deinit(gpa);
    var diag: Diagnostic = .{};

    try std.testing.expectEqual(0, FakeConn.opened);
    const a = try pool.acquire(&diag);
    a.release();
    const b = try pool.acquire(&diag);
    b.release();
    try std.testing.expectEqual(1, FakeConn.opened);
}

test "a broken connection is replaced on the next acquire" {
    const gpa = std.testing.allocator;
    FakeConn.opened = 0;
    FakeConn.closed = 0;
    var pool: Pool(FakeConn) = try .init(gpa, std.testing.io, .{ .fail = false }, 1);
    defer pool.deinit(gpa);
    var diag: Diagnostic = .{};

    const a = try pool.acquire(&diag);
    a.conn.ok = false;
    a.release();
    try std.testing.expectEqual(1, FakeConn.closed);
    const b = try pool.acquire(&diag);
    b.release();
    try std.testing.expectEqual(2, FakeConn.opened);
}

test "a failed connect frees the slot and reports why" {
    const gpa = std.testing.allocator;
    var pool: Pool(FakeConn) = try .init(gpa, std.testing.io, .{ .fail = true }, 1);
    defer pool.deinit(gpa);
    var diag: Diagnostic = .{};

    try std.testing.expectError(error.ConnectFailed, pool.acquire(&diag));
    try std.testing.expectEqualStrings("refused", diag.message());
    try std.testing.expect(!pool.busy[0]);
}
