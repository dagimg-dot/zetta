//! Caller-owned detail for the last error. A fixed buffer, so reporting an
//! error never allocates and never fails.

const std = @import("std");

const Diagnostic = @This();

/// Room for a Postgres error with its LINE context and caret under a long statement.
buf: [4096]u8 = undefined,
len: usize = 0,

pub fn set(d: *Diagnostic, text: []const u8) void {
    const trimmed = std.mem.trimEnd(u8, text, " \r\n");
    const n = @min(trimmed.len, d.buf.len);
    @memcpy(d.buf[0..n], trimmed[0..n]);
    d.len = n;
}

pub fn print(d: *Diagnostic, comptime fmt: []const u8, args: anytype) void {
    var w: std.Io.Writer = .fixed(&d.buf);
    w.print(fmt, args) catch {};
    d.len = w.end;
}

pub fn message(d: *const Diagnostic) []const u8 {
    return d.buf[0..d.len];
}

test "long messages are cut to the buffer instead of failing" {
    var d: Diagnostic = .{};
    const long = "x" ** 5000;
    d.set(long);
    try std.testing.expectEqual(d.buf.len, d.message().len);
    d.print("{s}", .{long});
    try std.testing.expectEqual(d.buf.len, d.message().len);
}

test "trailing newlines from drivers are trimmed" {
    var d: Diagnostic = .{};
    d.set("ERROR: boom\n\n");
    try std.testing.expectEqualStrings("ERROR: boom", d.message());
}
