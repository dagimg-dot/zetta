//! What every command gets from main: allocators, io, the environment and
//! the two output streams. Results go to stdout, everything else to stderr.

const std = @import("std");
const cli = @import("cli");
const db = @import("db");

const Context = @This();

gpa: std.mem.Allocator,
/// Lives until the process exits.
arena: std.mem.Allocator,
io: std.Io,
env: *const std.process.Environ.Map,
stdout: *std.Io.Writer,
stderr: *std.Io.Writer,
/// Whether stdout is a terminal that takes color.
color_stdout: bool,
version: []const u8,

pub fn fail(ctx: *Context, comptime fmt: []const u8, args: anytype) cli.ExitCode {
    ctx.printError(fmt, args);
    return .failure;
}

pub fn usageError(ctx: *Context, comptime fmt: []const u8, args: anytype) cli.ExitCode {
    ctx.printError(fmt, args);
    return .usage;
}

fn printError(ctx: *Context, comptime fmt: []const u8, args: anytype) void {
    ctx.stderr.print("error: " ++ fmt ++ "\n", args) catch {};
    ctx.stderr.flush() catch {};
}

pub const Opened = union(enum) { ok: db.Adapter, exit: cli.ExitCode };

/// Parses the DSN and opens the adapter, reporting any failure. The caller
/// owns the adapter.
pub fn openDatabase(ctx: *Context, text: []const u8, options: db.OpenOptions) Opened {
    return ctx.openDatabaseWaiting(text, options, 0);
}

/// Like openDatabase, but keeps trying for up to `wait_s` seconds while the database
/// refuses connections, as one starting alongside zetta does.
pub fn openDatabaseWaiting(ctx: *Context, text: []const u8, options: db.OpenOptions, wait_s: u32) Opened {
    const dsn = db.dsn.parse(ctx.arena, text) catch |err| return .{ .exit = switch (err) {
        error.OutOfMemory => ctx.fail("out of memory", .{}),
        error.Empty => ctx.usageError("the database is empty", .{}),
        error.UnknownScheme => ctx.usageError(
            "cannot tell which database '{s}' is; use postgres://..., sqlite:<path> or a .db/.sqlite file",
            .{db.dsn.redactAlloc(ctx.arena, text) catch return .{ .exit = ctx.fail("out of memory", .{}) }},
        ),
    } };
    var with_env = options;
    with_env.env = ctx.env;
    var buf: [512]u8 = undefined;
    var redacted: std.Io.Writer = .fixed(&buf);
    db.dsn.redact(text, &redacted) catch {}; // A DSN longer than the buffer is shown cut short.

    var opener: Opener = .{ .ctx = ctx, .dsn = dsn, .options = with_env, .shown = redacted.buffered(), .wait_s = wait_s };
    const adapter = untilConnected(db.Adapter, ctx.io, .{ .budget_ms = wait_s *| 1000 }, &opener) catch |err| {
        const why = opener.diag.message();
        return .{ .exit = ctx.fail("cannot open {s}: {s}", .{ opener.shown, if (why.len > 0) why else @errorName(err) }) };
    };
    return .{ .ok = adapter };
}

const Opener = struct {
    ctx: *Context,
    dsn: db.dsn.Dsn,
    options: db.OpenOptions,
    shown: []const u8,
    wait_s: u32,
    diag: db.Diagnostic = .{},

    fn run(o: *Opener) db.Error!db.Adapter {
        o.diag = .{};
        return db.open(o.ctx.gpa, o.ctx.io, o.dsn, o.options, &o.diag);
    }

    /// Says once that zetta is waiting, and why, so a slow start does not look like a hang.
    fn retrying(o: *Opener, tries: u32) void {
        if (tries != 1) return;
        o.ctx.stderr.print("waiting up to {d}s for {s}: {s}\n", .{ o.wait_s, o.shown, o.diag.message() }) catch {}; // stderr is best effort.
        o.ctx.stderr.flush() catch {}; // As above.
    }
};

pub const Wait = struct {
    budget_ms: u32,
    interval_ms: u32 = 1000,
};

/// Calls `attempt.run()` until it succeeds, fails with anything but error.ConnectFailed, or
/// `wait.budget_ms` has passed. Before each new try it calls `attempt.retrying(tries so far)`.
fn untilConnected(comptime T: type, io: std.Io, wait: Wait, attempt: anytype) db.Error!T {
    const deadline = std.Io.Timestamp.now(io, .awake).addDuration(.fromMilliseconds(wait.budget_ms));
    var tries: u32 = 0;
    while (true) {
        tries += 1;
        if (attempt.run()) |value| return value else |err| {
            if (err != error.ConnectFailed) return err;
            if (std.Io.Timestamp.now(io, .awake).nanoseconds >= deadline.nanoseconds) return err;
            attempt.retrying(tries);
            io.sleep(.fromMilliseconds(wait.interval_ms), .awake) catch return err; // Canceled: give up with the last failure.
        }
    }
}

const Flaky = struct {
    fail_first: u32,
    err: db.Error = error.ConnectFailed,
    runs: u32 = 0,
    retried: u32 = 0,

    fn run(f: *Flaky) db.Error!u32 {
        f.runs += 1;
        if (f.runs <= f.fail_first) return f.err;
        return f.runs;
    }

    fn retrying(f: *Flaky, tries: u32) void {
        std.debug.assert(tries == f.runs);
        f.retried += 1;
    }
};

test "a database that refuses at first is tried again until it answers" {
    var f: Flaky = .{ .fail_first = 2 };
    try std.testing.expectEqual(3, try untilConnected(u32, std.testing.io, .{ .budget_ms = 5_000, .interval_ms = 1 }, &f));
    try std.testing.expectEqual(2, f.retried);
}

test "no wait means one try" {
    var f: Flaky = .{ .fail_first = 1 };
    try std.testing.expectError(error.ConnectFailed, untilConnected(u32, std.testing.io, .{ .budget_ms = 0, .interval_ms = 1 }, &f));
    try std.testing.expectEqual(1, f.runs);
}

test "failures other than connecting are not retried" {
    var f: Flaky = .{ .fail_first = 5, .err = error.ReadOnly };
    try std.testing.expectError(error.ReadOnly, untilConnected(u32, std.testing.io, .{ .budget_ms = 5_000, .interval_ms = 1 }, &f));
    try std.testing.expectEqual(1, f.runs);
}

test "the wait gives up once its budget is spent" {
    var f: Flaky = .{ .fail_first = std.math.maxInt(u32) };
    try std.testing.expectError(error.ConnectFailed, untilConnected(u32, std.testing.io, .{ .budget_ms = 30, .interval_ms = 5 }, &f));
    try std.testing.expect(f.runs > 1);
}
