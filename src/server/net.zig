//! Listening sockets that no second process can share, and the addresses the startup URLs name.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const posix = std.posix;
const Threaded = Io.Threaded;

pub const ListenError = error{
    AddressInUse,
    /// The address is not one of this machine's.
    AddressUnavailable,
    /// A port below 1024 without the privilege to bind it.
    AccessDenied,
    SystemResources,
    Unexpected,
};

/// Listens on `address` with SO_REUSEADDR alone, so a restart can bind while old connections
/// linger in TIME_WAIT. `IpAddress.listen` with `reuse_address` also sets SO_REUSEPORT, which
/// lets a second process bind the same port and take a share of its connections. Port 0 asks
/// the system for a free port; the returned socket's address holds the one it got.
pub fn listen(io: Io, address: Io.net.IpAddress) ListenError!Io.net.Server {
    if (builtin.os.tag == .windows) return address.listen(io, .{}) catch |err| switch (err) {
        error.AddressInUse => error.AddressInUse,
        error.AddressUnavailable => error.AddressUnavailable,
        else => error.Unexpected,
    };

    var storage: Threaded.PosixAddress = undefined;
    var len = Threaded.addressToPosix(&address, &storage);
    const flags: u32 = posix.SOCK.STREAM | if (Threaded.socket_flags_unsupported) 0 else posix.SOCK.CLOEXEC;
    const rc = posix.system.socket(storage.any.family, flags, 0);
    const fd: posix.fd_t = switch (posix.errno(rc)) {
        .SUCCESS => @intCast(rc),
        .MFILE, .NFILE, .NOBUFS, .NOMEM => return error.SystemResources,
        else => return error.Unexpected,
    };
    errdefer _ = posix.system.close(fd);
    if (Threaded.socket_flags_unsupported) {
        if (posix.errno(posix.system.fcntl(fd, posix.F.SETFD, @as(usize, posix.FD_CLOEXEC))) != .SUCCESS) return error.Unexpected;
    }

    const on: c_int = 1;
    posix.setsockopt(fd, posix.SOL.SOCKET, posix.SO.REUSEADDR, std.mem.asBytes(&on)) catch |err| switch (err) {
        error.SystemResources => return error.SystemResources,
        else => return error.Unexpected,
    };
    switch (posix.errno(posix.system.bind(fd, &storage.any, len))) {
        .SUCCESS => {},
        .ADDRINUSE => return error.AddressInUse,
        .ADDRNOTAVAIL => return error.AddressUnavailable,
        .ACCES, .PERM => return error.AccessDenied,
        .NOMEM, .NOBUFS => return error.SystemResources,
        else => return error.Unexpected,
    }
    switch (posix.errno(posix.system.listen(fd, 128))) {
        .SUCCESS => {},
        .ADDRINUSE => return error.AddressInUse,
        else => return error.Unexpected,
    }
    if (posix.errno(posix.system.getsockname(fd, &storage.any, &len)) != .SUCCESS) return error.Unexpected;
    return .{ .socket = .{ .handle = fd, .address = Threaded.addressFromPosix(&storage) }, .options = {} };
}

/// Whether another server holds `port` on the wildcard addresses, as Vite checks before it
/// takes a port: a server on 0.0.0.0 can hide behind a free 127.0.0.1 on some systems.
pub fn heldOnWildcard(io: Io, port: u16) bool {
    for ([_][]const u8{ "0.0.0.0", "::" }) |host| {
        const address = Io.net.IpAddress.parse(host, port) catch unreachable;
        var probe = listen(io, address) catch |err| switch (err) {
            error.AddressInUse => return true,
            // No IPv6 on this machine, say, which leaves nothing there to collide with.
            else => continue,
        };
        probe.deinit(io);
    }
    return false;
}

const ifaddrs = extern struct {
    next: ?*ifaddrs,
    name: [*:0]const u8,
    flags: c_uint,
    addr: ?*posix.sockaddr,
    netmask: ?*posix.sockaddr,
    broadcast_or_destination: ?*posix.sockaddr,
    data: ?*anyopaque,
};
extern "c" fn getifaddrs(list: *?*ifaddrs) c_int;
extern "c" fn freeifaddrs(list: ?*ifaddrs) void;

const iff_up = 0x1;
const iff_loopback = 0x8;

/// The IPv4 addresses other machines can reach this one on, for the network lines printed
/// when zetta listens on all interfaces. Empty when the system will not say.
pub fn lanAddresses(arena: std.mem.Allocator) ![]const [4]u8 {
    if (builtin.os.tag == .windows) return &.{};
    var list: ?*ifaddrs = null;
    if (getifaddrs(&list) != 0) return &.{};
    defer freeifaddrs(list);
    var out: std.ArrayList([4]u8) = .empty;
    var at = list;
    while (at) |ifa| : (at = ifa.next) {
        const addr = ifa.addr orelse continue;
        if (ifa.flags & iff_up == 0 or ifa.flags & iff_loopback != 0) continue;
        if (isVirtual(std.mem.span(ifa.name))) continue;
        if (addr.family != posix.AF.INET) continue;
        const in: *const posix.sockaddr.in = @ptrCast(@alignCast(addr));
        try out.append(arena, @bitCast(in.addr));
    }
    return out.toOwnedSlice(arena);
}

/// Bridges that container and VM managers create on the host. Nothing outside the machine
/// reaches them, and a Docker host can have dozens.
fn isVirtual(name: []const u8) bool {
    for ([_][]const u8{ "docker", "br-", "veth", "virbr", "cni", "podman" }) |prefix| {
        if (std.mem.startsWith(u8, name, prefix)) return true;
    }
    return false;
}

test "container and VM bridges are not offered as network addresses" {
    for ([_][]const u8{ "docker0", "br-3ca8daf09af5", "veth1a2b", "virbr0", "cni0", "podman1" }) |n|
        try std.testing.expect(isVirtual(n));
    for ([_][]const u8{ "wlan0", "eth0", "en0", "enp3s0", "wg0" }) |n|
        try std.testing.expect(!isVirtual(n));
}

test "a second listener on the same port is refused" {
    const io = std.testing.io;
    var first = try listen(io, try Io.net.IpAddress.parse("127.0.0.1", 0));
    defer first.deinit(io);
    const port = first.socket.address.getPort();
    try std.testing.expect(port != 0);
    try std.testing.expectError(error.AddressInUse, listen(io, try Io.net.IpAddress.parse("127.0.0.1", port)));
}

test "a port held on loopback counts as held on the wildcard" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;
    const io = std.testing.io;
    var held = try listen(io, try Io.net.IpAddress.parse("127.0.0.1", 0));
    defer held.deinit(io);
    try std.testing.expect(heldOnWildcard(io, held.socket.address.getPort()));
}

test "a free port is not held on the wildcard" {
    const io = std.testing.io;
    var probe = try listen(io, try Io.net.IpAddress.parse("127.0.0.1", 0));
    const port = probe.socket.address.getPort();
    probe.deinit(io);
    try std.testing.expect(!heldOnWildcard(io, port));
}

test "lan addresses leave out loopback" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    for (try lanAddresses(arena.allocator())) |a| try std.testing.expect(a[0] != 127);
}
