//! Orchestration only: parse argv, then either print what the CLI layer
//! asked for or run a command, and turn the result into an exit code.

const std = @import("std");
const build_options = @import("build_options");
const cli = @import("cli");
const commands = @import("commands/root.zig");
const log = @import("log.zig");

const Cli = commands.Cli;
const File = std.Io.File;

/// Release builds carry no unwind tables, so a stack trace could not be printed anyway;
/// the simple handler prints the message and traps, and keeps the trace code out (about 40 KB).
pub const panic = if (@import("builtin").mode == .Debug) std.debug.FullPanic(std.debug.defaultPanic) else std.debug.simple_panic;

pub const std_options: std.Options = .{
    .log_level = .debug,
    .logFn = log.logFn,
};

const version = build_options.version;
const long_version = version ++ " (" ++ build_options.git_commit ++ ")";

pub fn main(init: std.process.Init) u8 {
    const io = init.io;
    const arena = init.arena.allocator();

    var stdout_buf: [16 * 1024]u8 = undefined;
    var stderr_buf: [4 * 1024]u8 = undefined;
    // Streaming, not positional: both may be redirected to the same file.
    var stdout_writer = File.stdout().writerStreaming(io, &stdout_buf);
    var stderr_writer = File.stderr().writerStreaming(io, &stderr_buf);
    const stdout = &stdout_writer.interface;
    const stderr = &stderr_writer.interface;

    const code = dispatch(init, arena, stdout, stderr) catch |err| blk: {
        stderr.print("error: {t}\n", .{err}) catch {};
        break :blk cli.ExitCode.failure;
    };
    stdout.flush() catch {};
    stderr.flush() catch {};
    return @intFromEnum(code);
}

fn dispatch(init: std.process.Init, arena: std.mem.Allocator, stdout: *std.Io.Writer, stderr: *std.Io.Writer) !cli.ExitCode {
    const io = init.io;
    const argv = try args(arena, init.minimal.args);
    const env = init.environ_map;

    switch (cli.parse(Cli, argv, env)) {
        .run => |parsed| {
            log.setLevel(parsed.verbose, parsed.quiet);
            var ctx: commands.Context = .{
                .gpa = init.gpa,
                .arena = arena,
                .io = io,
                .stdout = stdout,
                .stderr = stderr,
                .color_stdout = useColor(io, env, parsed.color, File.stdout()),
                .version = version,
            };
            return commands.run(&ctx, parsed.command);
        },
        .help => |req| {
            try cli.renderHelp(Cli, req, stdout, .{ .color = useColor(io, env, .auto, File.stdout()) });
            return .success;
        },
        .version => {
            try stdout.print("zetta {s}\n", .{long_version});
            return .success;
        },
        .completion_script => |shell| {
            try cli.completionScript(Cli, shell, stdout);
            return .success;
        },
        .complete => |words| {
            try cli.completionCandidates(Cli, words, stdout);
            return .success;
        },
        .spec => {
            try cli.writeSpec(Cli, version, stdout);
            return .success;
        },
        .failure => |failure| {
            try cli.renderFailure(failure, stderr, .{ .color = useColor(io, env, .auto, File.stderr()) });
            return .usage;
        },
    }
}

/// argv without the program name.
fn args(arena: std.mem.Allocator, raw: std.process.Args) ![]const []const u8 {
    const all = try raw.toSlice(arena);
    const out = try arena.alloc([]const u8, all.len -| 1);
    for (out, all[1..]) |*dst, src| dst.* = src;
    return out;
}

fn useColor(io: std.Io, env: *const std.process.Environ.Map, when: commands.Color, file: File) bool {
    return switch (when) {
        .always => true,
        .never => false,
        .auto => env.get("NO_COLOR") == null and (file.isTty(io) catch false),
    };
}
