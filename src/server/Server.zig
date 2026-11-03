//! Accepts connections and runs each one as a concurrent task.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const db = @import("db");
const handlers = @import("handlers.zig");

const log = std.log.scoped(.server);

const Server = @This();

gpa: Allocator,
ctx: handlers.Context,
listener: Io.net.Server,
group: Io.Group = .init,

pub const Config = struct {
    host: []const u8,
    port: u16,
    token: []const u8,
    name: []const u8,
    version: []const u8,
};

pub const ListenError = error{InvalidAddress} || Io.net.IpAddress.ListenError;

pub fn listen(gpa: Allocator, io: Io, adapter: db.Adapter, config: Config) ListenError!Server {
    const address = Io.net.IpAddress.parse(config.host, config.port) catch return error.InvalidAddress;
    const listener = try address.listen(io, .{ .reuse_address = true });
    return .{
        .gpa = gpa,
        .ctx = .{ .io = io, .adapter = adapter, .token = config.token, .name = config.name, .version = config.version },
        .listener = listener,
    };
}

pub fn deinit(self: *Server) void {
    self.group.cancel(self.ctx.io);
    self.listener.deinit(self.ctx.io);
}

/// Accepts until the task is cancelled.
pub fn run(self: *Server) Io.Cancelable!void {
    const io = self.ctx.io;
    while (true) {
        const stream = self.listener.accept(io) catch |err| switch (err) {
            error.Canceled => return error.Canceled,
            else => {
                log.warn("accept failed: {t}", .{err});
                continue;
            },
        };
        self.group.concurrent(io, serveConnection, .{ self, stream }) catch |err| {
            log.warn("dropping connection: {t}", .{err});
            stream.close(io);
        };
    }
}

fn serveConnection(self: *Server, stream: Io.net.Stream) void {
    const io = self.ctx.io;
    defer stream.close(io);
    var read_buf: [16 * 1024]u8 = undefined;
    var write_buf: [16 * 1024]u8 = undefined;
    var reader = stream.reader(io, &read_buf);
    var writer = stream.writer(io, &write_buf);
    var http: std.http.Server = .init(&reader.interface, &writer.interface);

    var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
    defer arena_state.deinit();
    while (true) {
        _ = arena_state.reset(.retain_capacity);
        var req = http.receiveHead() catch return;
        const method = req.head.method;
        var path_buf: [128]u8 = undefined;
        const path = copyPath(&path_buf, req.head.target);
        const started = Io.Timestamp.now(io, .awake);

        const status = handlers.handle(&self.ctx, arena_state.allocator(), &req) catch |err| {
            log.warn("{t} {s} failed: {t}", .{ method, path, err });
            return;
        };
        const ms = @divTrunc(started.untilNow(io, .awake).toNanoseconds(), std.time.ns_per_ms);
        log.info("{t} {s} {d} {d}ms", .{ method, path, @intFromEnum(status), ms });
    }
}

/// The path without the query string, which can hold the token or a filter.
fn copyPath(buf: []u8, target: []const u8) []const u8 {
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    const n = @min(path.len, buf.len);
    @memcpy(buf[0..n], path[0..n]);
    return buf[0..n];
}

test "logged paths never include the query string" {
    var buf: [128]u8 = undefined;
    try std.testing.expectEqualStrings("/", copyPath(&buf, "/?token=secret"));
}
