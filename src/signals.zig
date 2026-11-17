//! In a container zetta usually runs as PID 1, and Linux drops every signal that PID 1
//! leaves at its default action. Without handlers, Ctrl-C does nothing and `docker stop`
//! waits out its grace period before killing zetta.

const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const linux = std.os.linux;

/// As PID 1 on Linux, exits on SIGINT and SIGTERM as any other process dies of them.
pub fn exitOnStopAsInit() void {
    if (builtin.os.tag != .linux or linux.getpid() != 1) return;
    exitOnStop();
}

fn exitOnStop() void {
    const act: posix.Sigaction = .{
        .handler = .{ .handler = exitBySignal },
        .mask = posix.sigemptyset(),
        .flags = 0,
    };
    posix.sigaction(.INT, &act, null);
    posix.sigaction(.TERM, &act, null);
}

/// 128 plus the signal number is the status a shell reports for a process killed by it.
fn exitBySignal(sig: posix.SIG) callconv(.c) void {
    linux.exit_group(128 + @as(i32, @intCast(@intFromEnum(sig))));
}

test "SIGINT and SIGTERM end the process with the shell's status for them" {
    if (builtin.os.tag != .linux) return error.SkipZigTest;
    for ([_]posix.SIG{ .INT, .TERM }) |sig| {
        const pid: linux.pid_t = @intCast(@as(isize, @bitCast(linux.fork())));
        try std.testing.expect(pid >= 0);
        if (pid == 0) {
            exitOnStop();
            _ = linux.kill(linux.getpid(), sig);
            linux.exit_group(0);
        }
        var status: u32 = 0;
        _ = linux.waitpid(pid, &status, 0);
        try std.testing.expect(linux.W.IFEXITED(status));
        try std.testing.expectEqual(128 + @intFromEnum(sig), linux.W.EXITSTATUS(status));
    }
}
