//! From a parsed connection string and the environment to the settings one
//! connection uses, with libpq's precedence: the string, then PG* variables,
//! then defaults, and the password file last.

const std = @import("std");
const builtin = @import("builtin");
const mem = std.mem;
const Allocator = mem.Allocator;
const conninfo = @import("conninfo.zig");
const Diagnostic = @import("../Diagnostic.zig");

pub const Env = ?*const std.process.Environ.Map;

pub const Settings = struct {
    /// TCP host name (also used to verify the server certificate), or null for a Unix socket.
    host: ?[]const u8,
    hostaddr: ?[]const u8,
    /// Directories to look for the Unix socket in, tried in order.
    socket_dirs: []const []const u8,
    port: u16,
    user: []const u8,
    password: ?[]const u8,
    dbname: []const u8,
    sslmode: conninfo.SslMode,
    /// A file path, "system", or null for the system store.
    sslrootcert: ?[]const u8,
    channel_binding_required: bool,
    application_name: []const u8,
    options: ?[]const u8,
    connect_timeout_s: ?u32,
    read_only: bool,
};

/// libpq waits on the kernel when connect_timeout is unset, which is two minutes or more
/// for a host whose firewall drops packets. zetta gives up sooner and says why; 0 still
/// waits as long as the kernel does.
pub const default_connect_timeout_s = 10;

/// Debian, Arch and Fedora patch libpq to /run/postgresql; upstream uses /tmp.
const default_socket_dirs = [_][]const u8{ "/run/postgresql", "/tmp" };

/// Where libpq's defaults differ. Windows has no socket directory to try, so the host is
/// localhost, and the password file lives under %APPDATA%.
pub const Platform = enum { posix, windows };
const native: Platform = if (builtin.os.tag == .windows) .windows else .posix;

fn envGet(env: Env, key: []const u8) ?[]const u8 {
    const map = env orelse return null;
    const v = map.get(key) orelse return null;
    return if (v.len == 0) null else v;
}

pub fn resolve(
    arena: Allocator,
    io: std.Io,
    cfg: conninfo.Config,
    env: Env,
    read_only: bool,
    diag: *Diagnostic,
) error{ InvalidSettings, OutOfMemory }!Settings {
    return resolveOn(native, arena, io, cfg, env, read_only, diag);
}

pub fn resolveOn(
    platform: Platform,
    arena: Allocator,
    io: std.Io,
    cfg: conninfo.Config,
    env: Env,
    read_only: bool,
    diag: *Diagnostic,
) error{ InvalidSettings, OutOfMemory }!Settings {
    const host_raw = cfg.host orelse envGet(env, "PGHOST");
    const hostaddr = cfg.hostaddr orelse envGet(env, "PGHOSTADDR");
    const port_text = cfg.port orelse envGet(env, "PGPORT") orelse "5432";
    const port = std.fmt.parseInt(u16, port_text, 10) catch {
        diag.print("invalid port number: \"{s}\"", .{port_text});
        return error.InvalidSettings;
    };

    var host: ?[]const u8 = null;
    var socket_dirs: []const []const u8 = if (platform == .windows) &.{} else &default_socket_dirs;
    if (host_raw) |h| {
        if (mem.indexOfScalar(u8, h, ',') != null) {
            diag.set("multiple hosts are not supported");
            return error.InvalidSettings;
        }
        if (h.len > 0 and h[0] == '/') {
            socket_dirs = try arena.dupe([]const u8, &.{h});
        } else {
            host = h;
        }
    }
    if (host == null and hostaddr != null) host = hostaddr;
    if (host == null and socket_dirs.len == 0) host = "localhost";

    const user = cfg.user orelse envGet(env, "PGUSER") orelse envGet(env, "USER") orelse envGet(env, "LOGNAME") orelse envGet(env, "USERNAME") orelse "postgres";
    const dbname = cfg.dbname orelse envGet(env, "PGDATABASE") orelse user;
    const sslrootcert = cfg.sslrootcert orelse envGet(env, "PGSSLROOTCERT");
    const sslmode_text = cfg.sslmode orelse envGet(env, "PGSSLMODE") orelse conninfo.defaultSslMode(sslrootcert);
    const sslmode = conninfo.SslMode.parse(sslmode_text) orelse {
        diag.print("invalid sslmode value: \"{s}\"", .{sslmode_text});
        return error.InvalidSettings;
    };

    const channel_binding = cfg.channel_binding orelse envGet(env, "PGCHANNELBINDING") orelse "prefer";
    if (!mem.eql(u8, channel_binding, "disable") and !mem.eql(u8, channel_binding, "prefer") and !mem.eql(u8, channel_binding, "require")) {
        diag.print("invalid channel_binding value: \"{s}\"", .{channel_binding});
        return error.InvalidSettings;
    }

    const timeout_text = cfg.connect_timeout orelse envGet(env, "PGCONNECT_TIMEOUT");
    const timeout: ?u32 = if (timeout_text) |t| blk: {
        const v = std.fmt.parseInt(u32, t, 10) catch {
            diag.print("invalid integer value \"{s}\" for connection option \"connect_timeout\"", .{t});
            return error.InvalidSettings;
        };
        // libpq treats anything below 2 seconds, other than 0, as 2.
        break :blk if (v == 0) null else @max(v, 2);
    } else default_connect_timeout_s;

    var password = cfg.password orelse envGet(env, "PGPASSWORD");
    if (password == null) {
        const passfile = cfg.passfile orelse envGet(env, "PGPASSFILE") orelse try defaultPassfile(arena, platform, env);
        if (passfile) |path| {
            const pass_host = host orelse "localhost";
            password = lookupPassfile(arena, io, path, pass_host, port_text, dbname, user);
        }
    }

    return .{
        .host = host,
        .hostaddr = hostaddr,
        .socket_dirs = socket_dirs,
        .port = port,
        .user = user,
        .password = password,
        .dbname = dbname,
        .sslmode = sslmode,
        .sslrootcert = sslrootcert,
        .channel_binding_required = mem.eql(u8, channel_binding, "require"),
        .application_name = cfg.application_name orelse envGet(env, "PGAPPNAME") orelse "zetta",
        .options = cfg.options orelse envGet(env, "PGOPTIONS"),
        .connect_timeout_s = timeout,
        .read_only = read_only,
    };
}

fn defaultPassfile(arena: Allocator, platform: Platform, env: Env) Allocator.Error!?[]const u8 {
    return switch (platform) {
        .posix => if (envGet(env, "HOME")) |home| try std.fmt.allocPrint(arena, "{s}/.pgpass", .{home}) else null,
        .windows => if (envGet(env, "APPDATA")) |dir| try std.fmt.allocPrint(arena, "{s}\\postgresql\\pgpass.conf", .{dir}) else null,
    };
}

fn lookupPassfile(arena: Allocator, io: std.Io, path: []const u8, host: []const u8, port: []const u8, db: []const u8, user: []const u8) ?[]const u8 {
    const text = std.Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(1 << 20)) catch return null;
    return matchPassfile(arena, text, host, port, db, user) catch null;
}

/// Lines are host:port:database:user:password; `*` matches anything and `\` escapes `:` and `\`.
pub fn matchPassfile(arena: Allocator, text: []const u8, host: []const u8, port: []const u8, db: []const u8, user: []const u8) Allocator.Error!?[]const u8 {
    var lines = mem.splitScalar(u8, text, '\n');
    while (lines.next()) |raw| {
        const line = mem.trimEnd(u8, raw, "\r");
        if (line.len == 0 or line[0] == '#') continue;
        var fields: [5]std.ArrayList(u8) = @splat(.empty);
        var idx: usize = 0;
        var i: usize = 0;
        while (i < line.len) : (i += 1) {
            const ch = line[i];
            if (ch == '\\' and i + 1 < line.len) {
                i += 1;
                try fields[idx].append(arena, line[i]);
            } else if (ch == ':' and idx < 4) {
                idx += 1;
            } else {
                try fields[idx].append(arena, ch);
            }
        }
        if (idx != 4) continue;
        const want = [4][]const u8{ host, port, db, user };
        const ok = for (want, fields[0..4]) |w, f| {
            if (!mem.eql(u8, f.items, "*") and !mem.eql(u8, f.items, w)) break false;
        } else true;
        if (ok) return fields[4].items;
    }
    return null;
}

const testing = std.testing;

test "the password file matches with wildcards and escapes" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const text =
        \\# comment
        \\other:5432:*:jd:nope
        \\localhost:*:app:jd:pa\:ss\\word
        \\*:*:*:*:fallback
    ;
    try testing.expectEqualStrings("pa:ss\\word", (try matchPassfile(arena, text, "localhost", "5432", "app", "jd")).?);
    try testing.expectEqualStrings("fallback", (try matchPassfile(arena, text, "db.example", "5432", "app", "jd")).?);
}

test "environment fills what the string leaves out, and the string wins" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env: std.process.Environ.Map = .init(arena);
    try env.put("PGHOST", "envhost");
    try env.put("PGPORT", "6000");
    try env.put("PGUSER", "envuser");
    try env.put("PGSSLMODE", "require");
    var diag: Diagnostic = .{};
    const s = try resolve(arena, testing.io, .{ .port = "7000", .dbname = "app" }, &env, false, &diag);
    try testing.expectEqualStrings("envhost", s.host.?);
    try testing.expectEqual(7000, s.port);
    try testing.expectEqualStrings("envuser", s.user);
    try testing.expectEqualStrings("app", s.dbname);
    try testing.expectEqual(conninfo.SslMode.require, s.sslmode);
}

test "connect_timeout defaults to a bound, and 0 waits as long as the kernel does" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var diag: Diagnostic = .{};
    try testing.expectEqual(default_connect_timeout_s, (try resolve(arena, testing.io, .{}, null, false, &diag)).connect_timeout_s);
    try testing.expectEqual(null, (try resolve(arena, testing.io, .{ .connect_timeout = "0" }, null, false, &diag)).connect_timeout_s);
    try testing.expectEqual(2, (try resolve(arena, testing.io, .{ .connect_timeout = "1" }, null, false, &diag)).connect_timeout_s);
}

test "a socket directory host means a Unix socket" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    const s = try resolve(arena_state.allocator(), testing.io, .{ .host = "/var/run/pg" }, null, false, &diag);
    try testing.expectEqual(null, s.host);
    try testing.expectEqualStrings("/var/run/pg", s.socket_dirs[0]);
}

test "bad settings are reported, not guessed" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var diag: Diagnostic = .{};
    try testing.expectError(error.InvalidSettings, resolve(arena_state.allocator(), testing.io, .{ .port = "x" }, null, false, &diag));
    try testing.expectError(error.InvalidSettings, resolve(arena_state.allocator(), testing.io, .{ .sslmode = "maybe" }, null, false, &diag));
    try testing.expectEqualStrings("invalid sslmode value: \"maybe\"", diag.message());
}

test "on Windows the defaults are localhost, USERNAME and the password file under APPDATA" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var env: std.process.Environ.Map = .init(arena);
    try env.put("USERNAME", "winuser");
    try env.put("APPDATA", "C:\\Users\\winuser\\AppData\\Roaming");
    var diag: Diagnostic = .{};

    const s = try resolveOn(.windows, arena, testing.io, .{}, &env, false, &diag);
    try testing.expectEqualStrings("localhost", s.host.?);
    try testing.expectEqual(0, s.socket_dirs.len);
    try testing.expectEqualStrings("winuser", s.user);
    try testing.expectEqualStrings("C:\\Users\\winuser\\AppData\\Roaming\\postgresql\\pgpass.conf", (try defaultPassfile(arena, .windows, &env)).?);

    const posix = try resolveOn(.posix, arena, testing.io, .{}, &env, false, &diag);
    try testing.expectEqual(null, posix.host);
    try testing.expectEqualStrings("/run/postgresql", posix.socket_dirs[0]);
}
