//! Connection strings, parsed the way libpq parses them: `postgres://` URIs and
//! `key=value` strings. The URI tests at the bottom are ported from libpq's own
//! src/interfaces/libpq/t/001_uri.pl, expected output and error text included.

const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;
const dsn = @import("../dsn.zig");

pub const SslMode = enum {
    disable,
    allow,
    prefer,
    require,
    verify_ca,
    verify_full,

    pub fn parse(name_text: []const u8) ?SslMode {
        inline for (@typeInfo(SslMode).@"enum".fields) |f| {
            var kebab: [f.name.len]u8 = f.name[0..f.name.len].*;
            mem.replaceScalar(u8, &kebab, '_', '-');
            if (mem.eql(u8, name_text, &kebab)) return @field(SslMode, f.name);
        }
        return null;
    }

    pub fn name(mode: SslMode) []const u8 {
        return switch (mode) {
            .disable => "disable",
            .allow => "allow",
            .prefer => "prefer",
            .require => "require",
            .verify_ca => "verify-ca",
            .verify_full => "verify-full",
        };
    }
};

/// What the string set. Unset means "use the environment or the default".
pub const Config = struct {
    user: ?[]const u8 = null,
    password: ?[]const u8 = null,
    passfile: ?[]const u8 = null,
    channel_binding: ?[]const u8 = null,
    connect_timeout: ?[]const u8 = null,
    dbname: ?[]const u8 = null,
    host: ?[]const u8 = null,
    hostaddr: ?[]const u8 = null,
    port: ?[]const u8 = null,
    options: ?[]const u8 = null,
    application_name: ?[]const u8 = null,
    sslmode: ?[]const u8 = null,
    sslrootcert: ?[]const u8 = null,
};

/// Keywords zetta acts on, in libpq's PQconninfoOptions order.
const known = [_][]const u8{
    "user",             "password", "passfile",    "channel_binding", "connect_timeout",
    "dbname",           "host",     "hostaddr",    "port",            "options",
    "application_name", "sslmode",  "sslrootcert",
};

/// libpq keywords that are accepted and ignored, so strings copied from other
/// tools still work. Ones that change security behaviour are refused at connect.
const ignored = [_][]const u8{
    "client_encoding",     "fallback_application_name", "keepalives",               "keepalives_idle",
    "keepalives_interval", "keepalives_count",          "tcp_user_timeout",         "target_session_attrs",
    "load_balance_hosts",  "sslsni",                    "sslcompression",           "sslnegotiation",
    "gssencmode",          "krbsrvname",                "gsslib",                   "gssdelegation",
    "sslcert",             "sslkey",                    "sslpassword",              "sslcertmode",
    "sslcrl",              "sslcrldir",                 "ssl_min_protocol_version", "ssl_max_protocol_version",
    "requirepeer",         "require_auth",              "service",                  "replication",
};

pub const Error = error{ InvalidConnInfo, OutOfMemory };

/// Fills `err_buf` with libpq's message for the first problem found.
pub fn parse(arena: Allocator, text: []const u8, err: *ErrorText) Error!Config {
    const uri_prefixes = [_][]const u8{ "postgresql://", "postgres://" };
    for (uri_prefixes) |p| {
        if (mem.startsWith(u8, text, p)) return parseUri(arena, text, p.len, err);
    }
    return parseKeywords(arena, text, err);
}

pub const ErrorText = struct {
    buf: [512]u8 = undefined,
    len: usize = 0,

    fn set(e: *ErrorText, comptime fmt: []const u8, args: anytype) Error {
        var w: std.Io.Writer = .fixed(&e.buf);
        w.print(fmt, args) catch {};
        e.len = w.end;
        return error.InvalidConnInfo;
    }

    pub fn message(e: *const ErrorText) []const u8 {
        return e.buf[0..e.len];
    }
};

fn setOption(cfg: *Config, key: []const u8, value: []const u8) bool {
    inline for (known) |name| {
        if (mem.eql(u8, key, name)) {
            @field(cfg, name) = value;
            return true;
        }
    }
    for (ignored) |name| if (mem.eql(u8, key, name)) return true;
    return false;
}

fn parseUri(arena: Allocator, uri: []const u8, prefix_len: usize, err: *ErrorText) Error!Config {
    var cfg: Config = .{};
    var i = prefix_len;

    // userinfo@ comes before the first '/' or '?', if there is an '@' at all.
    const authority_end = mem.indexOfAnyPos(u8, uri, i, "/?") orelse uri.len;
    if (mem.lastIndexOfScalar(u8, uri[i..authority_end], '@')) |rel_at| {
        const at = i + rel_at;
        const userinfo = uri[i..at];
        if (mem.indexOfScalar(u8, userinfo, ':')) |colon| {
            const user = try decode(arena, userinfo[0..colon], .public, err);
            if (user.len > 0) cfg.user = user;
            cfg.password = try decode(arena, userinfo[colon + 1 ..], .secret, err);
        } else {
            const user = try decode(arena, userinfo, .public, err);
            if (user.len > 0) cfg.user = user;
        }
        i = at + 1;
    }

    if (i < uri.len and uri[i] == '[') {
        const close = mem.indexOfScalarPos(u8, uri, i + 1, ']') orelse
            return err.set("end of string reached when looking for matching \"]\" in IPv6 host address in URI: \"{s}\"", .{try dsn.redactAlloc(arena, uri)});
        if (close == i + 1) return err.set("IPv6 host address may not be empty in URI: \"{s}\"", .{try dsn.redactAlloc(arena, uri)});
        cfg.host = uri[i + 1 .. close];
        i = close + 1;
        if (i < uri.len and mem.indexOfScalar(u8, ":/?,", uri[i]) == null) {
            return err.set("unexpected character \"{c}\" at position {d} in URI (expected \":\" or \"/\"): \"{s}\"", .{ uri[i], i + 1, try dsn.redactAlloc(arena, uri) });
        }
    } else {
        const end = mem.indexOfAnyPos(u8, uri, i, ":/?,") orelse uri.len;
        const host = try decode(arena, uri[i..end], .public, err);
        if (host.len > 0) cfg.host = host;
        i = end;
    }

    if (i < uri.len and uri[i] == ',') return err.set("multiple hosts are not supported: \"{s}\"", .{try dsn.redactAlloc(arena, uri)});

    if (i < uri.len and uri[i] == ':') {
        const end = mem.indexOfAnyPos(u8, uri, i + 1, "/?") orelse uri.len;
        const port = try decode(arena, uri[i + 1 .. end], .public, err);
        if (port.len > 0) cfg.port = port;
        i = end;
    }

    if (i < uri.len and uri[i] == '/') {
        const end = mem.indexOfScalarPos(u8, uri, i + 1, '?') orelse uri.len;
        const db = try decode(arena, uri[i + 1 .. end], .public, err);
        if (db.len > 0) cfg.dbname = db;
        i = end;
    }

    if (i < uri.len and uri[i] == '?') {
        var params = mem.splitScalar(u8, uri[i + 1 ..], '&');
        while (params.next()) |param| {
            if (param.len == 0) continue;
            const eq = mem.indexOfScalar(u8, param, '=') orelse
                return err.set("missing key/value separator \"=\" in URI query parameter: \"{s}\"", .{param});
            if (mem.indexOfScalarPos(u8, param, eq + 1, '=') != null)
                return err.set("extra key/value separator \"=\" in URI query parameter: \"{s}\"", .{param[0..eq]});
            const key = try decode(arena, param[0..eq], .public, err);
            const value = try decode(arena, param[eq + 1 ..], if (isSecret(key)) .secret else .public, err);
            if (!setOption(&cfg, key, value)) return err.set("invalid URI query parameter: \"{s}\"", .{key});
        }
    }
    return cfg;
}

const Exposure = enum { public, secret };

fn isSecret(key: []const u8) bool {
    return mem.eql(u8, key, "password") or mem.eql(u8, key, "sslpassword");
}

/// Percent-decodes one part of a URI. An error quotes the part, as libpq does, unless it is a
/// password: the message reaches the terminal and the server log.
fn decode(arena: Allocator, text: []const u8, exposure: Exposure, err: *ErrorText) Error![]const u8 {
    if (mem.indexOfScalar(u8, text, '%') == null) return text;
    const shown = if (exposure == .secret) "***" else text;
    const out = try arena.alloc(u8, text.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] != '%') {
            out[n] = text[i];
            n += 1;
            continue;
        }
        if (i + 2 >= text.len) return err.set("invalid percent-encoded token: \"{s}\"", .{shown});
        const byte = std.fmt.parseInt(u8, text[i + 1 .. i + 3], 16) catch
            return err.set("invalid percent-encoded token: \"{s}\"", .{shown});
        if (byte == 0) return err.set("forbidden value %00 in percent-encoded value: \"{s}\"", .{shown});
        out[n] = byte;
        n += 1;
        i += 2;
    }
    return out[0..n];
}

fn parseKeywords(arena: Allocator, text: []const u8, err: *ErrorText) Error!Config {
    var cfg: Config = .{};
    var i: usize = 0;
    while (true) {
        while (i < text.len and std.ascii.isWhitespace(text[i])) i += 1;
        if (i >= text.len) break;

        const key_start = i;
        while (i < text.len and text[i] != '=' and !std.ascii.isWhitespace(text[i])) i += 1;
        const key = text[key_start..i];
        while (i < text.len and std.ascii.isWhitespace(text[i])) i += 1;
        if (i >= text.len or text[i] != '=') return err.set("missing \"=\" after \"{s}\" in connection info string", .{key});
        i += 1;
        while (i < text.len and std.ascii.isWhitespace(text[i])) i += 1;

        var value: std.ArrayList(u8) = .empty;
        if (i < text.len and text[i] == '\'') {
            i += 1;
            while (true) {
                if (i >= text.len) return err.set("unterminated quoted string in connection info string", .{});
                if (text[i] == '\\' and i + 1 < text.len) {
                    try value.append(arena, text[i + 1]);
                    i += 2;
                } else if (text[i] == '\'') {
                    i += 1;
                    break;
                } else {
                    try value.append(arena, text[i]);
                    i += 1;
                }
            }
        } else {
            while (i < text.len and !std.ascii.isWhitespace(text[i])) {
                if (text[i] == '\\' and i + 1 < text.len) i += 1;
                try value.append(arena, text[i]);
                i += 1;
            }
        }
        if (!setOption(&cfg, key, value.items)) return err.set("invalid connection option \"{s}\"", .{key});
    }
    return cfg;
}

/// The default sslmode: verify-full when the system CA store is in use, as in libpq.
pub fn defaultSslMode(sslrootcert: ?[]const u8) []const u8 {
    if (sslrootcert) |root| if (mem.eql(u8, root, "system")) return "verify-full";
    return "prefer";
}

/// Prints the options that differ from the defaults, then (local) or (inet),
/// exactly as libpq's libpq_uri_regress does. Used by the ported tests.
pub fn describe(cfg: Config, env_sslrootcert: ?[]const u8, w: *std.Io.Writer) std.Io.Writer.Error!void {
    var local = true;
    inline for (known) |name| {
        if (@field(cfg, name)) |value| {
            const default: ?[]const u8 = if (comptime mem.eql(u8, name, "port"))
                "5432"
            else if (comptime mem.eql(u8, name, "sslmode"))
                defaultSslMode(cfg.sslrootcert orelse env_sslrootcert)
            else
                null;
            if (default == null or !mem.eql(u8, value, default.?)) try w.print("{s}='{s}' ", .{ name, value });
            if (value.len > 0) {
                if (comptime mem.eql(u8, name, "hostaddr")) local = false;
                if (comptime mem.eql(u8, name, "host")) {
                    if (value[0] != '/') local = false;
                }
            }
        }
    }
    try w.writeAll(if (local) "(local)" else "(inet)");
}

const testing = std.testing;

const UriCase = struct {
    uri: []const u8,
    want: []const u8,
    err: []const u8 = "",
    sslrootcert_env: ?[]const u8 = null,
};

/// From PostgreSQL REL_17_STABLE src/interfaces/libpq/t/001_uri.pl (PostgreSQL License).
const uri_cases = [_]UriCase{
    .{ .uri = "postgresql://uri-user:secret@host:12345/db", .want = "user='uri-user' password='secret' dbname='db' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://uri-user@host:12345/db", .want = "user='uri-user' dbname='db' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://uri-user@host/db", .want = "user='uri-user' dbname='db' host='host' (inet)" },
    .{ .uri = "postgresql://host:12345/db", .want = "dbname='db' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host/db", .want = "dbname='db' host='host' (inet)" },
    .{ .uri = "postgresql://uri-user@host:12345/", .want = "user='uri-user' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://uri-user@host/", .want = "user='uri-user' host='host' (inet)" },
    .{ .uri = "postgresql://uri-user@", .want = "user='uri-user' (local)" },
    .{ .uri = "postgresql://host:12345/", .want = "host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host:12345", .want = "host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host/db", .want = "dbname='db' host='host' (inet)" },
    .{ .uri = "postgresql://host/", .want = "host='host' (inet)" },
    .{ .uri = "postgresql://host", .want = "host='host' (inet)" },
    .{ .uri = "postgresql://", .want = "(local)" },
    .{ .uri = "postgresql://?hostaddr=127.0.0.1", .want = "hostaddr='127.0.0.1' (inet)" },
    .{ .uri = "postgresql://example.com?hostaddr=63.1.2.4", .want = "host='example.com' hostaddr='63.1.2.4' (inet)" },
    .{ .uri = "postgresql://%68ost/", .want = "host='host' (inet)" },
    .{ .uri = "postgresql://host/db?user=uri-user", .want = "user='uri-user' dbname='db' host='host' (inet)" },
    .{ .uri = "postgresql://host/db?user=uri-user&port=12345", .want = "user='uri-user' dbname='db' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host/db?u%73er=someotheruser&port=12345", .want = "user='someotheruser' dbname='db' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host/db?u%7aer=someotheruser&port=12345", .want = "", .err = "invalid URI query parameter: \"uzer\"" },
    .{ .uri = "postgresql://host:12345?user=uri-user", .want = "user='uri-user' host='host' port='12345' (inet)" },
    .{ .uri = "postgresql://host?user=uri-user", .want = "user='uri-user' host='host' (inet)" },
    .{ .uri = "postgresql://host?", .want = "host='host' (inet)" },
    .{ .uri = "postgresql://[::1]:12345/db", .want = "dbname='db' host='::1' port='12345' (inet)" },
    .{ .uri = "postgresql://[::1]/db", .want = "dbname='db' host='::1' (inet)" },
    .{ .uri = "postgresql://[2001:db8::1234]/", .want = "host='2001:db8::1234' (inet)" },
    .{ .uri = "postgresql://[200z:db8::1234]/", .want = "host='200z:db8::1234' (inet)" },
    .{ .uri = "postgresql://[::1]", .want = "host='::1' (inet)" },
    .{ .uri = "postgres://", .want = "(local)" },
    .{ .uri = "postgres:///", .want = "(local)" },
    .{ .uri = "postgres:///db", .want = "dbname='db' (local)" },
    .{ .uri = "postgres://uri-user@/db", .want = "user='uri-user' dbname='db' (local)" },
    .{ .uri = "postgres://?host=/path/to/socket/dir", .want = "host='/path/to/socket/dir' (local)" },
    .{ .uri = "postgresql://host?uzer=", .want = "", .err = "invalid URI query parameter: \"uzer\"" },
    .{ .uri = "postgre://", .want = "", .err = "missing \"=\" after \"postgre://\" in connection info string" },
    .{ .uri = "postgres://[::1", .want = "", .err = "end of string reached when looking for matching \"]\" in IPv6 host address in URI: \"postgres://[::1\"" },
    .{ .uri = "postgres://[]", .want = "", .err = "IPv6 host address may not be empty in URI: \"postgres://[]\"" },
    .{ .uri = "postgres://[::1]z", .want = "", .err = "unexpected character \"z\" at position 17 in URI (expected \":\" or \"/\"): \"postgres://[::1]z\"" },
    .{ .uri = "postgresql://host?zzz", .want = "", .err = "missing key/value separator \"=\" in URI query parameter: \"zzz\"" },
    .{ .uri = "postgresql://host?value1&value2", .want = "", .err = "missing key/value separator \"=\" in URI query parameter: \"value1\"" },
    .{ .uri = "postgresql://host?key=key=value", .want = "", .err = "extra key/value separator \"=\" in URI query parameter: \"key\"" },
    .{ .uri = "postgres://host?dbname=%XXfoo", .want = "", .err = "invalid percent-encoded token: \"%XXfoo\"" },
    .{ .uri = "postgresql://a%00b", .want = "", .err = "forbidden value %00 in percent-encoded value: \"a%00b\"" },
    .{ .uri = "postgresql://%zz", .want = "", .err = "invalid percent-encoded token: \"%zz\"" },
    .{ .uri = "postgresql://%1", .want = "", .err = "invalid percent-encoded token: \"%1\"" },
    .{ .uri = "postgresql://%", .want = "", .err = "invalid percent-encoded token: \"%\"" },
    .{ .uri = "postgres://@host", .want = "host='host' (inet)" },
    .{ .uri = "postgres://host:/", .want = "host='host' (inet)" },
    .{ .uri = "postgres://:12345/", .want = "port='12345' (local)" },
    .{ .uri = "postgres://otheruser@?host=/no/such/directory", .want = "user='otheruser' host='/no/such/directory' (local)" },
    .{ .uri = "postgres://otheruser@/?host=/no/such/directory", .want = "user='otheruser' host='/no/such/directory' (local)" },
    .{ .uri = "postgres://otheruser@:12345?host=/no/such/socket/path", .want = "user='otheruser' host='/no/such/socket/path' port='12345' (local)" },
    .{ .uri = "postgres://otheruser@:12345/db?host=/path/to/socket", .want = "user='otheruser' dbname='db' host='/path/to/socket' port='12345' (local)" },
    .{ .uri = "postgres://:12345/db?host=/path/to/socket", .want = "dbname='db' host='/path/to/socket' port='12345' (local)" },
    .{ .uri = "postgres://:12345?host=/path/to/socket", .want = "host='/path/to/socket' port='12345' (local)" },
    .{ .uri = "postgres://%2Fvar%2Flib%2Fpostgresql/dbname", .want = "dbname='dbname' host='/var/lib/postgresql' (local)" },
    .{ .uri = "postgresql://host?sslmode=disable", .want = "host='host' sslmode='disable' (inet)", .sslrootcert_env = "system" },
    .{ .uri = "postgresql://host?sslmode=prefer", .want = "host='host' sslmode='prefer' (inet)", .sslrootcert_env = "system" },
    .{ .uri = "postgresql://host?sslmode=verify-full", .want = "host='host' (inet)", .sslrootcert_env = "system" },
};

test "every libpq URI case parses to libpq's answer" {
    var failures: usize = 0;
    for (uri_cases) |case| {
        var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
        defer arena_state.deinit();
        var err: ErrorText = .{};
        var buf: [512]u8 = undefined;
        var w: std.Io.Writer = .fixed(&buf);
        if (parse(arena_state.allocator(), case.uri, &err)) |cfg| {
            try describe(cfg, case.sslrootcert_env, &w);
        } else |e| switch (e) {
            error.InvalidConnInfo => {},
            error.OutOfMemory => return e,
        }
        const got_ok = w.buffered();
        if (!mem.eql(u8, got_ok, case.want) or !mem.eql(u8, err.message(), case.err)) {
            std.debug.print("\n{s}\n  want: {s}{s}\n  got:  {s}{s}\n", .{ case.uri, case.want, case.err, got_ok, err.message() });
            failures += 1;
        }
    }
    try testing.expectEqual(0, failures);
}

test "a connection string error never quotes a password" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const cases = [_][]const u8{
        "postgres://u:pa%ss@h/db",
        "postgres://u:pa%00ss@h/db",
        "postgres://u@h/db?password=pa%ss",
        "postgres://u:hunter2@h1,h2/db",
        "postgres://u:hunter2@[::1]z/db",
        "postgres://u:hunter2@[]/db",
    };
    for (cases) |uri| {
        var err: ErrorText = .{};
        try testing.expectError(error.InvalidConnInfo, parse(arena_state.allocator(), uri, &err));
        try testing.expect(mem.indexOf(u8, err.message(), "pa%") == null);
        try testing.expect(mem.indexOf(u8, err.message(), "hunter2") == null);
    }
}

test "keyword strings handle quoting and escapes" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var err: ErrorText = .{};
    const cfg = try parse(arena_state.allocator(), "host=db.local  port = 6543 password='it\\'s secret' dbname=app\\ one", &err);
    try testing.expectEqualStrings("db.local", cfg.host.?);
    try testing.expectEqualStrings("6543", cfg.port.?);
    try testing.expectEqualStrings("it's secret", cfg.password.?);
    try testing.expectEqualStrings("app one", cfg.dbname.?);
    try testing.expectError(error.InvalidConnInfo, parse(arena_state.allocator(), "host=x bogus=1", &err));
    try testing.expectEqualStrings("invalid connection option \"bogus\"", err.message());
}

test "libpq options zetta does not use are accepted" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    var err: ErrorText = .{};
    const cfg = try parse(arena_state.allocator(), "postgresql://h/db?sslmode=require&target_session_attrs=any&keepalives=1", &err);
    try testing.expectEqualStrings("require", cfg.sslmode.?);
}

test "sslmode names" {
    try testing.expectEqual(SslMode.verify_full, SslMode.parse("verify-full").?);
    try testing.expectEqual(null, SslMode.parse("verify_full"));
    try testing.expectEqualStrings("verify-ca", SslMode.verify_ca.name());
}
