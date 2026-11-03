//! The startup token, exchanged once for an HttpOnly session cookie.

const std = @import("std");

pub const cookie_name = "zetta";

/// 32 hex characters from the system CSPRNG.
pub fn randomToken(io: std.Io) [32]u8 {
    var raw: [16]u8 = undefined;
    io.random(&raw);
    return std.fmt.bytesToHex(raw, .lower);
}

/// Constant-time compare, so the token cannot be guessed byte by byte.
pub fn matches(given: []const u8, token: []const u8) bool {
    if (given.len != token.len) return false;
    var diff: u8 = 0;
    for (given, token) |a, b| diff |= a ^ b;
    return diff == 0;
}

pub fn setCookie(buf: []u8, token: []const u8) []const u8 {
    return std.fmt.bufPrint(buf, "{s}={s}; Path=/; HttpOnly; SameSite=Strict", .{ cookie_name, token }) catch unreachable;
}

pub fn isLoopback(host: []const u8) bool {
    const loopbacks = [_][]const u8{ "127.0.0.1", "::1", "localhost" };
    for (loopbacks) |l| if (std.mem.eql(u8, host, l)) return true;
    return std.mem.startsWith(u8, host, "127.");
}

const testing = std.testing;

test "tokens only match exactly" {
    try testing.expect(matches("abc", "abc"));
    try testing.expect(!matches("abd", "abc"));
    try testing.expect(!matches("ab", "abc"));
}

test "loopback hosts" {
    try testing.expect(isLoopback("127.0.0.1"));
    try testing.expect(isLoopback("127.1.2.3"));
    try testing.expect(isLoopback("::1"));
    try testing.expect(!isLoopback("0.0.0.0"));
    try testing.expect(!isLoopback("192.168.1.4"));
}
