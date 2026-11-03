//! Runtime log level on top of std.log, set once from -v/-q before any
//! thread starts.

const std = @import("std");

var level: std.log.Level = .warn;

pub fn setLevel(verbose: u8, quiet: bool) void {
    level = if (quiet) .err else switch (verbose) {
        0 => .warn,
        1 => .info,
        else => .debug,
    };
}

pub fn logFn(
    comptime message_level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    if (@intFromEnum(message_level) > @intFromEnum(level)) return;
    std.log.defaultLog(message_level, scope, format, args);
}
