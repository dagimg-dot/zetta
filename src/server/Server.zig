//! Accepts connections and runs each one as a concurrent task.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const db = @import("db");
const handlers = @import("handlers.zig");
const net = @import("net.zig");

const log = std.log.scoped(.server);

const Server = @This();

ctx: handlers.Context,
listener: Io.net.Server,
group: Io.Group = .init,

pub const Config = struct {
    host: []const u8,
    /// 0 asks the system for a free port.
    port: u16,
    /// How many ports above `port` to try when it is taken. 0 makes `port` the only choice.
    next_ports: u16 = 0,
    token: []const u8,
    /// As `handlers.Context.allowed_hosts`.
    allowed_hosts: []const u8 = "",
    /// Applied to every browse and query. Null means no limit.
    statement_timeout_ms: ?u32,
    name: []const u8,
    version: []const u8,
};

pub const ListenError = error{InvalidAddress} || net.ListenError;

/// Takes `config.port`, or with `next_ports` the first free port above it, the way Vite does:
/// a port counts as taken when anything holds it on the wildcard addresses or on `host`.
pub fn listen(io: Io, adapter: db.Adapter, config: Config) ListenError!Server {
    var candidate = config.port;
    const listener = while (true) : (candidate += 1) {
        const address = Io.net.IpAddress.parse(config.host, candidate) catch return error.InvalidAddress;
        const last = candidate == config.port +| config.next_ports or candidate == std.math.maxInt(u16);
        if (!last and candidate != 0 and net.heldOnWildcard(io, candidate)) continue;
        break net.listen(io, address) catch |err| switch (err) {
            error.AddressInUse => if (last) return err else continue,
            else => return err,
        };
    };
    return .{
        .ctx = .{
            .io = io,
            .adapter = adapter,
            .token = config.token,
            .allowed_hosts = config.allowed_hosts,
            .port = listener.socket.address.getPort(),
            .statement_timeout_ms = config.statement_timeout_ms,
            .name = config.name,
            .version = config.version,
        },
        .listener = listener,
    };
}

/// The port listened on, which differs from the one asked for after a move or with port 0.
pub fn port(self: *const Server) u16 {
    return self.ctx.port;
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
    sendSmallWritesAtOnce(stream);
    var read_buf: [16 * 1024]u8 = undefined;
    var write_buf: [16 * 1024]u8 = undefined;
    var reader = stream.reader(io, &read_buf);
    var writer = stream.writer(io, &write_buf);
    var http: std.http.Server = .init(&reader.interface, &writer.interface);

    // Pages rather than malloc, so what a large result used goes back to the OS on reset.
    var arena_state: std.heap.ArenaAllocator = .init(std.heap.page_allocator);
    defer arena_state.deinit();
    while (true) {
        _ = arena_state.reset(.{ .retain_with_limit = keep_between_requests });
        var req = http.receiveHead() catch |err| switch (err) {
            error.HttpConnectionClosing => return,
            error.HttpHeadersOversize => return refuseOversizedHead(&reader.interface, &writer.interface),
            else => {
                log.debug("closing connection: {t}", .{err});
                return;
            },
        };
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

/// Heads past this are not read to the end; the connection just closes.
const max_skipped_head = 1024 * 1024;

const oversized_body = "{\"error\":\"too_large\",\"message\":\"the request URL is over 16 KiB\"}";
const oversized_response = "HTTP/1.1 431 Request Header Fields Too Large\r\n" ++
    "content-type: application/json\r\n" ++
    std.fmt.comptimePrint("content-length: {d}\r\n", .{oversized_body.len}) ++
    "connection: close\r\n\r\n" ++ oversized_body;

/// Answers a request whose head does not fit the read buffer, such as a filter on a very long
/// value, so the browser gets a reason rather than a dropped connection. The rest of the head is
/// read first: closing with it unread would reset the connection and lose the answer.
fn refuseOversizedHead(in: *Io.Reader, out: *Io.Writer) void {
    var skipped: usize = 0;
    while (skipped < max_skipped_head) {
        const n = in.discardDelimiterInclusive('\n') catch |err| {
            log.debug("oversized request head ended early: {t}", .{err});
            return;
        };
        skipped += n;
        if (n <= 2) break;
    }
    log.info("refused a request head over {d} bytes", .{in.buffer.len});
    out.writeAll(oversized_response) catch |err| {
        log.debug("could not refuse an oversized head: {t}", .{err});
        return;
    };
    out.flush() catch |err| log.debug("could not refuse an oversized head: {t}", .{err});
}

/// What an idle keep-alive connection holds on to. A browser keeps several open, so keeping
/// each one's largest result would hold that memory for as long as the tab is open.
const keep_between_requests = 256 * 1024;

/// Results go out in chunks as they are written. With Nagle's algorithm on, the kernel holds a
/// short final chunk until the client acknowledges the last one, which a client delaying its
/// ACK makes about 40 ms on Linux.
///
/// Not on Windows: std.Io drives sockets there through AFD, and keeps its socket option call private.
fn sendSmallWritesAtOnce(stream: Io.net.Stream) void {
    if (builtin.os.tag == .windows) return;
    const on: c_int = 1;
    std.posix.setsockopt(stream.socket.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&on)) catch |err|
        log.warn("could not set TCP_NODELAY, large responses may stall: {t}", .{err});
}

/// The path without the query string, which can hold the token or a filter.
fn copyPath(buf: []u8, target: []const u8) []const u8 {
    const path = target[0 .. std.mem.indexOfScalar(u8, target, '?') orelse target.len];
    const n = @min(path.len, buf.len);
    @memcpy(buf[0..n], path[0..n]);
    return buf[0..n];
}

test "a request head too long for the buffer gets a 431 with a JSON reason" {
    const head = "GET /api/browse?q=" ++ "x" ** 300 ++ " HTTP/1.1\r\nhost: localhost\r\n\r\n";
    var in: Io.Reader = .fixed(head ++ "GET /next");
    var out_buf: [512]u8 = undefined;
    var out: Io.Writer = .fixed(&out_buf);
    refuseOversizedHead(&in, &out);
    try std.testing.expectEqualStrings(oversized_response, out.buffered());
    try std.testing.expectEqualStrings("GET /next", in.buffered());
}

test "logged paths never include the query string" {
    var buf: [128]u8 = undefined;
    try std.testing.expectEqualStrings("/", copyPath(&buf, "/?token=secret"));
}

test "accepted connections send small writes without waiting for an ACK" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    const io = std.testing.io;
    const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
    var listener = try address.listen(io, .{});
    defer listener.deinit(io);
    const client = try listener.socket.address.connect(io, .{ .mode = .stream });
    defer client.close(io);
    const accepted = try listener.accept(io);
    defer accepted.close(io);

    sendSmallWritesAtOnce(accepted);
    var value: c_int = 0;
    var len: std.posix.socklen_t = @sizeOf(c_int);
    try std.testing.expectEqual(0, std.posix.system.getsockopt(accepted.socket.handle, std.posix.IPPROTO.TCP, std.posix.TCP.NODELAY, std.mem.asBytes(&value), &len));
    try std.testing.expect(value != 0);
}

fn testListen(start: u16, next_ports: u16) ListenError!Server {
    return listen(std.testing.io, undefined, .{ .host = "127.0.0.1", .port = start, .next_ports = next_ports, .token = "t", .statement_timeout_ms = null, .name = "zetta", .version = "test" });
}

test "a taken port moves to the next free one when moving is allowed" {
    var held = try net.listen(std.testing.io, try Io.net.IpAddress.parse("127.0.0.1", 0));
    defer held.deinit(std.testing.io);
    const taken = held.socket.address.getPort();
    var srv = try testListen(taken, 20);
    defer srv.deinit();
    try std.testing.expect(srv.port() > taken and srv.port() <= taken + 20);
}

test "a taken port is refused when it is the only choice" {
    var held = try net.listen(std.testing.io, try Io.net.IpAddress.parse("127.0.0.1", 0));
    defer held.deinit(std.testing.io);
    try std.testing.expectError(error.AddressInUse, testListen(held.socket.address.getPort(), 0));
}

test "port 0 reports the port the system picked" {
    var srv = try testListen(0, 0);
    defer srv.deinit();
    try std.testing.expect(srv.port() != 0);
}
