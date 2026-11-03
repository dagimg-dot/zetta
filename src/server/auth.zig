//! The startup token, exchanged once for an HttpOnly session cookie.

const std = @import("std");

/// `zetta_1993`. Browsers keep one cookie per host whatever the port, so two zettas on one
/// machine would otherwise sign each other out.
pub fn cookieName(buf: *[cookie_name_max]u8, port: u16) []const u8 {
    return std.fmt.bufPrint(buf, "zetta_{d}", .{port}) catch unreachable; // "zetta_65535" fits.
}

pub const cookie_name_max = "zetta_65535".len;

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

pub fn setCookie(buf: []u8, port: u16, token: []const u8) []const u8 {
    var name_buf: [cookie_name_max]u8 = undefined;
    return std.fmt.bufPrint(buf, "{s}={s}; Path=/; HttpOnly; SameSite=Strict", .{ cookieName(&name_buf, port), token }) catch unreachable;
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

test "each port gets its own cookie, so two zettas on one host keep their sessions" {
    var a: [cookie_name_max]u8 = undefined;
    var b: [cookie_name_max]u8 = undefined;
    try std.testing.expectEqualStrings("zetta_1993", cookieName(&a, 1993));
    try std.testing.expectEqualStrings("zetta_65535", cookieName(&b, 65535));
    var buf: [128]u8 = undefined;
    try std.testing.expectEqualStrings("zetta_1994=abc; Path=/; HttpOnly; SameSite=Strict", setCookie(&buf, 1994, "abc"));
}
