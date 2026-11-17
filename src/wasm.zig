//! The in-browser demo: a WASI reactor that a page drives through these exports. It opens one
//! database and answers whole HTTP requests with the handlers the server uses, so the real UI
//! runs against it with no network.

const std = @import("std");
const build_options = @import("build_options");
const db = @import("db");
const server = @import("server");

const log = std.log.scoped(.wasm);
const gpa = std.heap.wasm_allocator;

/// The page sends it as the `zetta_0` cookie. Nothing leaves the tab, so it guards nothing.
const token = "wasm";
/// Nothing can interrupt a statement inside the page, so a runaway query must end by itself.
const statement_timeout_ms = 15_000;

var threaded: std.Io.Threaded = .init_single_threaded;
var ctx: ?server.Context = null;
/// The last response or error message, valid until the next call.
var output: []u8 = &.{};

export fn zetta_alloc(len: usize) ?[*]u8 {
    const mem = gpa.alloc(u8, len) catch return null; // The page reads null as out of memory.
    return mem.ptr;
}

export fn zetta_free(ptr: [*]u8, len: usize) void {
    gpa.free(ptr[0..len]);
}

/// Where the last response or error message starts.
export fn zetta_output() [*]const u8 {
    return output.ptr;
}

/// Opens `dsn` read-only. Returns true, or false with the reason at zetta_output.
export fn zetta_open(ptr: [*]const u8, len: usize) bool {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const target = db.dsn.parse(arena_state.allocator(), ptr[0..len]) catch |err| {
        keep(@errorName(err));
        return false;
    };
    var diag: db.Diagnostic = .{};
    const io = threaded.io();
    const adapter = db.open(gpa, io, target, .{ .read_only = true, .pool_size = 1 }, &diag) catch |err| {
        log.err("open failed: {t}", .{err});
        keep(if (diag.message().len > 0) diag.message() else @errorName(err));
        return false;
    };
    ctx = .{
        .io = io,
        .adapter = adapter,
        .token = token,
        .statement_timeout_ms = statement_timeout_ms,
        .name = "zetta",
        .version = build_options.version,
    };
    return true;
}

/// Answers one whole HTTP/1.1 request. Returns the response's length, or 0 when there is none.
export fn zetta_request(ptr: [*]const u8, len: usize) usize {
    const c = if (ctx) |*c| c else return 0;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    var out: std.Io.Writer.Allocating = .init(arena_state.allocator());
    _ = server.serveBytes(c, arena_state.allocator(), ptr[0..len], &out.writer) catch |err| {
        log.err("request failed: {t}", .{err});
        return 0;
    };
    keep(out.written());
    return output.len;
}

/// Copies `bytes` to `output`, replacing what was there.
fn keep(bytes: []const u8) void {
    gpa.free(output);
    output = gpa.dupe(u8, bytes) catch blk: {
        log.err("out of memory keeping {d} bytes", .{bytes.len});
        break :blk &.{};
    };
}
