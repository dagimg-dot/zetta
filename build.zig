const std = @import("std");
const zon = @import("build.zig.zon");

const Ui = enum {
    /// Run `bun run build` in web/ before compiling.
    bun,
    /// Use the existing web/dist/index.html.gz and csp.txt as they are.
    prebuilt,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const ui = b.option(Ui, "ui", "How to get the web UI (default: bun)") orelse .bun;
    // Release builds never print stack traces, so they need no unwind tables (about 125 KB).
    const unwind: ?std.builtin.UnwindTables = if (optimize == .Debug) null else .none;
    const strip = b.option(bool, "strip", "Strip symbols (default: on for release builds)") orelse (optimize != .Debug);
    // Test-only: run the Postgres suite through libpq too and compare results.
    // Needs libpq installed; the zetta binary itself never links it.
    const pg_oracle = b.option(bool, "pg-oracle", "Also build the libpq differential tests (default: false)") orelse false;

    const options = b.addOptions();
    options.addOption([]const u8, "version", zon.version);
    const commit = b.option([]const u8, "commit", "Commit shown by --version (default: git rev-parse)");
    options.addOption([]const u8, "git_commit", commit orelse gitShortHash(b));
    const options_mod = options.createModule();

    const sqlite = addSqlite(b, target, optimize, unwind);

    const db = b.createModule(.{
        .root_source_file = b.path("src/db/root.zig"),
        .target = target,
        .optimize = optimize,
        .unwind_tables = unwind,
        .strip = strip,
        .link_libc = true,
    });
    db.addIncludePath(b.path("vendor/sqlite3"));
    db.linkLibrary(sqlite);

    const cli = b.createModule(.{
        .root_source_file = b.path("src/cli/root.zig"),
        .target = target,
        .optimize = optimize,
        .unwind_tables = unwind,
        .strip = strip,
    });

    const render = b.createModule(.{
        .root_source_file = b.path("src/render/root.zig"),
        .target = target,
        .optimize = optimize,
        .unwind_tables = unwind,
        .strip = strip,
        .imports = &.{.{ .name = "db", .module = db }},
    });

    const server = b.createModule(.{
        .root_source_file = b.path("src/server/root.zig"),
        .target = target,
        .optimize = optimize,
        .unwind_tables = unwind,
        .strip = strip,
        .imports = &.{
            .{ .name = "db", .module = db },
            .{ .name = "render", .module = render },
        },
    });
    server.addAnonymousImport("ui_index", .{ .root_source_file = b.path("web/dist/index.html.gz") });
    server.addAnonymousImport("ui_csp", .{ .root_source_file = b.path("web/dist/csp.txt") });

    const exe = b.addExecutable(.{
        .name = "zetta",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .unwind_tables = unwind,
            .strip = strip,
            .imports = &.{
                .{ .name = "build_options", .module = options_mod },
                .{ .name = "cli", .module = cli },
                .{ .name = "db", .module = db },
                .{ .name = "render", .module = render },
                .{ .name = "server", .module = server },
            },
        }),
    });
    b.installArtifact(exe);

    var web_build: ?*std.Build.Step = null;
    if (ui == .bun) {
        const bun = b.addSystemCommand(&.{ "bun", "run", "build" });
        bun.setCwd(b.path("web"));
        bun.has_side_effects = true;
        web_build = &bun.step;
        exe.step.dependOn(&bun.step);
    }

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);
    b.step("run", "Run zetta").dependOn(&run_cmd.step);

    const test_step = b.step("test", "Run every test");
    const modules = [_]struct { []const u8, *std.Build.Module }{
        .{ "db", db },
        .{ "cli", cli },
        .{ "render", render },
        .{ "server", server },
        .{ "main", exe.root_module },
    };
    for (modules) |entry| {
        const name, const module = entry;
        const t = b.addTest(.{ .name = name, .root_module = module });
        if (web_build) |step| t.step.dependOn(step);
        const run = b.addRunArtifact(t);
        test_step.dependOn(&run.step);
        b.step(b.fmt("test-{s}", .{name}), b.fmt("Run the {s} tests", .{name})).dependOn(&run.step);
    }

    if (pg_oracle) {
        const oracle = b.createModule(.{
            .root_source_file = b.path("src/db/oracle.zig"),
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        oracle.linkSystemLibrary("pq", .{});
        oracle.addIncludePath(b.path("vendor/sqlite3"));
        oracle.linkLibrary(sqlite);
        const run = b.addRunArtifact(b.addTest(.{ .name = "pg-oracle", .root_module = oracle }));
        b.step("test-oracle", "Compare the native Postgres adapter with libpq (needs ZETTA_TEST_PG_URL)").dependOn(&run.step);
    }

    const check = b.step("check", "zig fmt --check + full build");
    check.dependOn(&b.addFmt(.{ .paths = &.{ "build.zig", "build.zig.zon", "src" }, .check = true }).step);
    check.dependOn(b.getInstallStep());
}

fn addSqlite(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
    unwind: ?std.builtin.UnwindTables,
) *std.Build.Step.Compile {
    const lib = b.addLibrary(.{
        .linkage = .static,
        .name = "sqlite3",
        .root_module = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .unwind_tables = unwind,
            .link_libc = true,
            // ReleaseSafe would trap on undefined behaviour inside SQLite, which costs 40 to 60%
            // on scans. SQLite is fuzzed far beyond what that catches; zetta's own code keeps its checks.
            .sanitize_c = if (optimize == .Debug) null else .off,
        }),
    });
    lib.root_module.addIncludePath(b.path("vendor/sqlite3"));
    lib.root_module.addCSourceFile(.{
        .file = b.path("vendor/sqlite3/sqlite3.c"),
        .flags = &.{
            // Each connection is used by one thread at a time (see db/pool.zig).
            "-DSQLITE_THREADSAFE=2",
            "-DSQLITE_DEFAULT_MEMSTATUS=0",
            "-DSQLITE_OMIT_LOAD_EXTENSION",
            "-DSQLITE_OMIT_DEPRECATED",
            "-DSQLITE_ENABLE_MATH_FUNCTIONS",
            // C-level features zetta never calls. Parser-changing omits are left
            // alone: they do not work with the amalgamation.
            "-DSQLITE_OMIT_UTF16",
            "-DSQLITE_OMIT_TRACE",
            "-DSQLITE_OMIT_COMPLETE",
            "-DSQLITE_OMIT_GET_TABLE",
            "-DSQLITE_OMIT_TCL_VARIABLE",
            "-DSQLITE_OMIT_INCRBLOB",
            "-DSQLITE_OMIT_AUTHORIZATION",
            "-DSQLITE_OMIT_COMPILEOPTION_DIAGS",
            "-DSQLITE_OMIT_DESERIALIZE",
            "-DSQLITE_OMIT_SEH",
            "-DSQLITE_UNTESTABLE",
            "-DSQLITE_OMIT_SHARED_CACHE",
            // The OR, BETWEEN, LIKE, TRUNCATE and XFER optimisations stay in. Without them indexed
            // queries become full scans and VACUUM fails on a table with a generated column, all to
            // save about 12 KB.
            // mmap is off by default anyway; this drops its code.
            "-DSQLITE_MAX_MMAP_SIZE=0",
        },
    });
    return lib;
}

fn gitShortHash(b: *std.Build) []const u8 {
    var code: u8 = 0;
    const out = b.runAllowFail(
        &.{ "git", "-C", b.build_root.path orelse ".", "rev-parse", "--short=7", "HEAD" },
        &code,
        .ignore,
    ) catch return "unknown";
    if (code != 0) return "unknown";
    const trimmed = std.mem.trim(u8, out, " \r\n");
    return if (trimmed.len > 0) trimmed else "unknown";
}
