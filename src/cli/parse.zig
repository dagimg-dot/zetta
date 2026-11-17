//! argv → typed command. Never allocates: values are slices of argv or of
//! the environment, and every table is built at compile time.

const std = @import("std");
const mem = std.mem;
const spec = @import("spec.zig");
const Option = spec.Option;

pub const Shell = enum { bash, zsh, fish };

pub const Failure = struct {
    kind: Kind,
    /// The offending argument, env var name or option label.
    token: []const u8 = "",
    /// What was expected: a value name or the allowed choices.
    expected: []const u8 = "",
    suggestion: ?[]const u8 = null,
    usage: []const u8 = "",

    pub const Kind = enum {
        unknown_argument,
        unknown_command,
        missing_value,
        invalid_value,
        invalid_env_value,
        missing_required,
        unexpected_argument,
    };
};

pub const HelpRequest = struct {
    /// Subcommand name, or null for the root.
    command: ?[]const u8,
    long: bool,
};

pub fn Outcome(comptime Root: type) type {
    return union(enum) {
        run: Root,
        help: HelpRequest,
        version,
        /// `completion <shell>`: print the script.
        completion_script: Shell,
        /// `__complete -- <words>`: print candidates for the last word.
        complete: []const []const u8,
        /// `__spec`: print the spec.
        spec,
        failure: Failure,
    };
}

/// `env` is anything with `get([]const u8) ?[]const u8`.
pub fn parse(comptime Root: type, argv: []const []const u8, env: anytype) Outcome(Root) {
    comptime spec.validate(Root);
    const Out = Outcome(Root);

    if (argv.len > 0 and mem.eql(u8, argv[0], "__complete")) {
        const rest = argv[1..];
        return .{ .complete = if (rest.len > 0 and mem.eql(u8, rest[0], "--")) rest[1..] else rest };
    }
    if (argv.len > 0 and mem.eql(u8, argv[0], "__spec")) return .spec;

    var root: Root = defaults(Root);
    var root_seen: [spec.options(Root).len]bool = @splat(false);
    var failure: Failure = undefined;
    var positional: usize = 0;
    const root_usage = comptime spec.usageLine(Root.name, null, Root);

    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const tok = argv[i];
        if (isFlag(tok)) {
            if (mem.eql(u8, tok, "-h") or mem.eql(u8, tok, "--help")) return .{ .help = .{ .command = null, .long = tok.len > 2 } };
            if (mem.eql(u8, tok, "-V") or mem.eql(u8, tok, "--version")) return .version;
            switch (matchOption(Root, &root, spec.options(Root), &root_seen, argv, &i, &failure)) {
                .matched => continue,
                .failed => return fail(Out, failure, root_usage),
                .not_found => return fail(Out, unknownArgument(Root, void, tok), root_usage),
            }
        }

        if (comptime spec.hasCommands(Root)) {
            inline for (comptime spec.commandFields(Root)) |f| {
                if (commandMatches(f, tok)) return parseCommand(Root, f.name, &root, &root_seen, argv[i + 1 ..], env);
            }
            if (mem.eql(u8, tok, "help")) {
                const target = if (i + 1 < argv.len) argv[i + 1] else null;
                if (target) |name| {
                    inline for (comptime spec.commandFields(Root)) |f| {
                        if (commandMatches(f, name)) return .{ .help = .{ .command = f.name, .long = true } };
                    }
                    if (mem.eql(u8, name, "completion")) return .{ .help = .{ .command = "completion", .long = true } };
                    return fail(Out, .{ .kind = .unknown_command, .token = name, .suggestion = suggestCommand(Root, name) }, root_usage);
                }
                return .{ .help = .{ .command = null, .long = true } };
            }
            if (mem.eql(u8, tok, "completion")) {
                for (argv[i + 1 ..]) |arg| {
                    if (mem.eql(u8, arg, "-h") or mem.eql(u8, arg, "--help")) return .{ .help = .{ .command = "completion", .long = arg.len > 2 } };
                }
                const name = if (i + 1 < argv.len) argv[i + 1] else return fail(Out, .{ .kind = .missing_required, .token = "<SHELL>" }, Root.name ++ " completion <SHELL>");
                const shell = std.meta.stringToEnum(Shell, name) orelse
                    return fail(Out, .{ .kind = .invalid_value, .token = name, .expected = "bash, zsh, fish" }, Root.name ++ " completion <SHELL>");
                return .{ .completion_script = shell };
            }
            if (comptime spec.defaultCommand(Root)) |default| {
                if (suggestCommand(Root, tok)) |close| {
                    return fail(Out, .{ .kind = .unknown_command, .token = tok, .suggestion = close }, root_usage);
                }
                return parseCommand(Root, default, &root, &root_seen, argv[i..], env);
            }
            return fail(Out, .{ .kind = .unknown_command, .token = tok, .suggestion = suggestCommand(Root, tok) }, root_usage);
        }

        switch (assignPositional(Root, &root, &root_seen, &positional, tok, &failure)) {
            .matched => {},
            else => return fail(Out, failure, root_usage),
        }
    }

    if (comptime spec.defaultCommand(Root)) |default| {
        return parseCommand(Root, default, &root, &root_seen, &.{}, env);
    }
    if (finish(Root, &root, spec.options(Root), &root_seen, env)) |f| return fail(Out, f, root_usage);
    return .{ .run = root };
}

fn parseCommand(
    comptime Root: type,
    comptime name: []const u8,
    root: *Root,
    root_seen: *[spec.options(Root).len]bool,
    argv: []const []const u8,
    env: anytype,
) Outcome(Root) {
    const Out = Outcome(Root);
    const Cmd = @FieldType(Root.Command, name);
    comptime spec.validate(Cmd);
    const opts = comptime spec.options(Cmd);
    const usage = comptime spec.usageLine(Root.name, name, Cmd);

    var cmd: Cmd = defaults(Cmd);
    var seen: [opts.len]bool = @splat(false);
    var failure: Failure = undefined;
    var positional: usize = 0;
    var only_positional = false;

    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const tok = argv[i];
        if (!only_positional and mem.eql(u8, tok, "--")) {
            only_positional = true;
            continue;
        }
        if (!only_positional and isFlag(tok)) {
            if (mem.eql(u8, tok, "-h") or mem.eql(u8, tok, "--help")) return .{ .help = .{ .command = name, .long = tok.len > 2 } };
            switch (matchOption(Cmd, &cmd, opts, &seen, argv, &i, &failure)) {
                .matched => continue,
                .failed => return fail(Out, failure, usage),
                .not_found => {},
            }
            switch (matchOption(Root, root, comptime spec.globals(Root), root_seen, argv, &i, &failure)) {
                .matched => continue,
                .failed => return fail(Out, failure, usage),
                .not_found => return fail(Out, unknownArgument(Root, Cmd, tok), usage),
            }
        }
        switch (assignPositional(Cmd, &cmd, &seen, &positional, tok, &failure)) {
            .matched => {},
            else => return fail(Out, failure, usage),
        }
    }

    if (finish(Cmd, &cmd, opts, &seen, env)) |f| return fail(Out, f, usage);
    if (finish(Root, root, comptime spec.options(Root), root_seen, env)) |f| return fail(Out, f, usage);
    root.command = @unionInit(Root.Command, name, cmd);
    return .{ .run = root.* };
}

fn fail(comptime Out: type, failure: Failure, usage: []const u8) Out {
    var f = failure;
    f.usage = usage;
    return .{ .failure = f };
}

const Match = enum { matched, not_found, failed };

fn isFlag(tok: []const u8) bool {
    return tok.len > 1 and tok[0] == '-';
}

fn commandMatches(comptime f: std.builtin.Type.UnionField, tok: []const u8) bool {
    if (mem.eql(u8, tok, comptime spec.kebab(f.name))) return true;
    inline for (comptime spec.aliases(f.type)) |alias| {
        if (mem.eql(u8, tok, alias)) return true;
    }
    return false;
}

fn defaults(comptime T: type) T {
    var value: T = undefined;
    inline for (@typeInfo(T).@"struct".fields) |f| {
        if (f.defaultValue()) |d| @field(value, f.name) = d;
    }
    return value;
}

fn matchOption(
    comptime T: type,
    target: *T,
    comptime opts: []const Option,
    seen: anytype,
    argv: []const []const u8,
    i: *usize,
    failure: *Failure,
) Match {
    const tok = argv[i.*];
    if (mem.startsWith(u8, tok, "--")) {
        const body = tok[2..];
        const eq = mem.indexOfScalar(u8, body, '=');
        const name = body[0 .. eq orelse body.len];
        const inline_value: ?[]const u8 = if (eq) |e| body[e + 1 ..] else null;
        inline for (opts, 0..) |o, k| {
            if (o.positional) continue;
            const long = comptime spec.longName(o);
            if (mem.eql(u8, name, long)) {
                seen[comptime optionIndex(T, o)] = true;
                _ = k;
                return apply(T, target, o, tok, inline_value, false, argv, i, failure);
            }
            if (o.negatable and mem.startsWith(u8, name, "no-") and mem.eql(u8, name[3..], long)) {
                seen[comptime optionIndex(T, o)] = true;
                return apply(T, target, o, tok, null, true, argv, i, failure);
            }
        }
        return .not_found;
    }

    // A cluster of shorts: -vvq, -p7777, -p 7777.
    var j: usize = 1;
    while (j < tok.len) : (j += 1) {
        const ch = tok[j];
        const matched = inline for (opts) |o| {
            if (o.short != null and !o.positional and o.short.? == ch) {
                seen[comptime optionIndex(T, o)] = true;
                if (comptime spec.takesValue(T, o)) {
                    const rest = tok[j + 1 ..];
                    return apply(T, target, o, tok, if (rest.len > 0) rest else null, false, argv, i, failure);
                }
                if (apply(T, target, o, tok, null, false, argv, i, failure) == .failed) return .failed;
                break true;
            }
        } else false;
        if (!matched) {
            if (j == 1) return .not_found;
            failure.* = .{ .kind = .unknown_argument, .token = tok };
            return .failed;
        }
    }
    return .matched;
}

/// Index of `o` in its own type's option list, for the seen table.
fn optionIndex(comptime T: type, comptime o: Option) usize {
    comptime {
        for (spec.options(T), 0..) |candidate, k| {
            if (mem.eql(u8, candidate.field, o.field)) return k;
        }
        unreachable;
    }
}

fn apply(
    comptime T: type,
    target: *T,
    comptime o: Option,
    tok: []const u8,
    inline_value: ?[]const u8,
    negate: bool,
    argv: []const []const u8,
    i: *usize,
    failure: *Failure,
) Match {
    const V = comptime spec.ValueType(T, o);
    if (o.count) {
        @field(target, o.field) +|= 1;
        return .matched;
    }
    if (V == bool) {
        const on = if (inline_value) |v| parseBool(v) orelse {
            failure.* = .{ .kind = .invalid_value, .token = v, .expected = "true or false" };
            return .failed;
        } else true;
        @field(target, o.field) = if (negate) !on else on;
        return .matched;
    }
    const text = inline_value orelse blk: {
        if (i.* + 1 >= argv.len) {
            failure.* = .{ .kind = .missing_value, .token = tok, .expected = comptime spec.valueName(o) };
            return .failed;
        }
        i.* += 1;
        break :blk argv[i.*];
    };
    @field(target, o.field) = parseValue(V, text) orelse {
        failure.* = .{ .kind = .invalid_value, .token = text, .expected = comptime expectedText(T, o) };
        return .failed;
    };
    return .matched;
}

fn assignPositional(comptime T: type, target: *T, seen: anytype, next: *usize, tok: []const u8, failure: *Failure) Match {
    var index: usize = 0;
    inline for (comptime spec.options(T)) |o| {
        if (!o.positional) continue;
        if (index == next.*) {
            const V = comptime spec.ValueType(T, o);
            @field(target, o.field) = parseValue(V, tok) orelse {
                failure.* = .{ .kind = .invalid_value, .token = tok, .expected = comptime expectedText(T, o) };
                return .failed;
            };
            seen[comptime optionIndex(T, o)] = true;
            next.* += 1;
            return .matched;
        }
        index += 1;
    }
    failure.* = .{ .kind = .unexpected_argument, .token = tok };
    return .failed;
}

/// Fills unset options from the environment, then checks required ones.
fn finish(comptime T: type, target: *T, comptime opts: []const Option, seen: anytype, env: anytype) ?Failure {
    inline for (opts) |o| {
        const k = comptime optionIndex(T, o);
        if (!seen[k]) {
            inline for (o.env) |name| {
                if (!seen[k]) {
                    if (env.get(name)) |text| {
                        const V = comptime spec.ValueType(T, o);
                        @field(target, o.field) = parseValue(V, text) orelse
                            return .{ .kind = .invalid_env_value, .token = name, .expected = comptime expectedText(T, o) };
                        seen[k] = true;
                    }
                }
            }
        }
        if (o.required and !seen[k]) {
            return .{ .kind = .missing_required, .token = comptime if (o.positional) spec.positionalLabel(o) else "--" ++ spec.longName(o) };
        }
    }
    return null;
}

fn expectedText(comptime T: type, comptime o: Option) []const u8 {
    comptime {
        const names = spec.choices(T, o);
        if (names.len == 0) {
            return switch (@typeInfo(spec.ValueType(T, o))) {
                .int => "a whole number",
                else => spec.valueName(o),
            };
        }
        var text: []const u8 = names[0];
        for (names[1..]) |n| text = text ++ ", " ++ n;
        return text;
    }
}

/// Booleans as usage defines them; an empty value is false.
pub fn parseBool(text: []const u8) ?bool {
    const yes = [_][]const u8{ "true", "1", "yes", "y", "on" };
    const no = [_][]const u8{ "false", "0", "no", "n", "off", "" };
    for (yes) |y| if (std.ascii.eqlIgnoreCase(text, y)) return true;
    for (no) |n| if (std.ascii.eqlIgnoreCase(text, n)) return false;
    return null;
}

fn parseValue(comptime V: type, text: []const u8) ?V {
    return switch (@typeInfo(V)) {
        .bool => parseBool(text),
        .int => std.fmt.parseInt(V, text, 10) catch null,
        .@"enum" => |e| inline for (e.fields) |f| {
            if (mem.eql(u8, text, comptime spec.kebab(f.name))) break @field(V, f.name);
        } else null,
        else => text,
    };
}

fn unknownArgument(comptime Root: type, comptime Cmd: type, tok: []const u8) Failure {
    const name = if (mem.startsWith(u8, tok, "--")) tok[2..] else tok[1..];
    const bare = name[0 .. mem.indexOfScalar(u8, name, '=') orelse name.len];
    var best: ?[]const u8 = null;
    var best_distance: usize = std.math.maxInt(usize);
    const candidates = comptime blk: {
        var list: []const []const u8 = &.{};
        const own = if (Cmd == void) spec.options(Root) else spec.options(Cmd) ++ spec.globals(Root);
        for (own) |o| {
            if (!o.positional and !o.hide) list = list ++ .{spec.longName(o)};
        }
        break :blk list ++ .{ "help", "version" };
    };
    inline for (candidates) |candidate| {
        const d = distance(bare, candidate);
        if (d < best_distance) {
            best_distance = d;
            best = "--" ++ candidate;
        }
    }
    const close_enough = best_distance <= @max(2, bare.len / 3);
    return .{ .kind = .unknown_argument, .token = tok, .suggestion = if (close_enough) best else null };
}

fn suggestCommand(comptime Root: type, tok: []const u8) ?[]const u8 {
    var best: ?[]const u8 = null;
    var best_distance: usize = std.math.maxInt(usize);
    inline for (comptime spec.commandFields(Root)) |f| {
        const name = comptime spec.kebab(f.name);
        const d = distance(tok, name);
        if (d < best_distance) {
            best_distance = d;
            best = name;
        }
    }
    return if (best_distance <= 2 and best_distance < tok.len) best else null;
}

/// Edit distance, capped at 32 characters so it needs no allocation.
fn distance(a: []const u8, b: []const u8) usize {
    const max = 32;
    if (a.len > max or b.len > max) return std.math.maxInt(usize);
    var prev: [max + 1]usize = undefined;
    var cur: [max + 1]usize = undefined;
    for (0..b.len + 1) |j| prev[j] = j;
    for (a, 0..) |ca, ai| {
        cur[0] = ai + 1;
        for (b, 0..) |cb, bi| {
            const cost: usize = if (ca == cb) 0 else 1;
            cur[bi + 1] = @min(@min(prev[bi + 1] + 1, cur[bi] + 1), prev[bi] + cost);
        }
        @memcpy(prev[0 .. b.len + 1], cur[0 .. b.len + 1]);
    }
    return prev[b.len];
}

const testing = std.testing;

const TestEnv = struct {
    pairs: []const [2][]const u8 = &.{},
    pub fn get(self: TestEnv, key: []const u8) ?[]const u8 {
        for (self.pairs) |p| if (mem.eql(u8, p[0], key)) return p[1];
        return null;
    }
};

const Color = enum { auto, always, never };

const Serve = struct {
    dsn: ?[]const u8 = null,
    host: []const u8 = "127.0.0.1",
    port: u16 = 7777,
    open: ?bool = null,
    read_only: bool = false,

    pub const about = "Serve the web UI";
    pub const options = [_]Option{
        .{ .field = "dsn", .positional = true, .required = true, .env = &.{ "ZETTA_DSN", "DATABASE_URL" }, .help = "Database" },
        .{ .field = "host", .short = 'H', .value_name = "ADDR", .env = &.{"ZETTA_HOST"}, .help = "Host" },
        .{ .field = "port", .short = 'p', .env = &.{"ZETTA_PORT"}, .help = "Port" },
        .{ .field = "open", .negatable = true, .help = "Open a browser" },
        .{ .field = "read_only", .env = &.{"ZETTA_READ_ONLY"}, .help = "Read only" },
    };
};

const Query = struct {
    dsn: ?[]const u8 = null,
    sql: ?[]const u8 = null,
    format: enum { table, json, csv } = .table,

    pub const aliases = [_][]const u8{"q"};
    pub const options = [_]Option{
        .{ .field = "dsn", .positional = true, .required = true, .help = "Database" },
        .{ .field = "sql", .positional = true, .help = "SQL" },
        .{ .field = "format", .short = 'f', .help = "Output format" },
    };
};

const TestCli = struct {
    verbose: u8 = 0,
    color: Color = .auto,
    command: Command = undefined,

    pub const name = "zetta";
    pub const default_command = "serve";
    pub const Command = union(enum) { serve: Serve, query: Query };
    pub const options = [_]Option{
        .{ .field = "verbose", .short = 'v', .count = true, .global = true, .help = "More logging" },
        .{ .field = "color", .global = true, .value_name = "WHEN", .help = "Color" },
    };
};

fn parseTest(argv: []const []const u8, env: TestEnv) Outcome(TestCli) {
    return parse(TestCli, argv, env);
}

test "flags, short clusters and globals after the subcommand" {
    const out = parseTest(&.{ "serve", "app.db", "-p", "9000", "--host=0.0.0.0", "-vv", "--color", "never" }, .{});
    const cli = out.run;
    try testing.expectEqual(2, cli.verbose);
    try testing.expectEqual(Color.never, cli.color);
    try testing.expectEqualStrings("app.db", cli.command.serve.dsn.?);
    try testing.expectEqual(9000, cli.command.serve.port);
    try testing.expectEqualStrings("0.0.0.0", cli.command.serve.host);
}

test "an attached short value works" {
    const out = parseTest(&.{ "serve", "x.db", "-p7000" }, .{});
    try testing.expectEqual(7000, out.run.command.serve.port);
}

test "argv beats env, env beats the default" {
    const env: TestEnv = .{ .pairs = &.{ .{ "ZETTA_PORT", "8000" }, .{ "DATABASE_URL", "env.db" }, .{ "ZETTA_HOST", "::1" } } };
    const out = parseTest(&.{ "serve", "--port", "9000" }, env);
    try testing.expectEqual(9000, out.run.command.serve.port);
    try testing.expectEqualStrings("env.db", out.run.command.serve.dsn.?);
    try testing.expectEqualStrings("::1", out.run.command.serve.host);
}

test "the first env name in the list wins" {
    const env: TestEnv = .{ .pairs = &.{ .{ "DATABASE_URL", "second.db" }, .{ "ZETTA_DSN", "first.db" } } };
    try testing.expectEqualStrings("first.db", parseTest(&.{"serve"}, env).run.command.serve.dsn.?);
}

test "a bare positional runs the default command" {
    const out = parseTest(&.{"./app.db"}, .{});
    try testing.expectEqualStrings("./app.db", out.run.command.serve.dsn.?);
}

test "negatable switches accept --no-" {
    try testing.expectEqual(false, parseTest(&.{ "serve", "a.db", "--no-open" }, .{}).run.command.serve.open.?);
    try testing.expectEqual(true, parseTest(&.{ "serve", "a.db", "--open" }, .{}).run.command.serve.open.?);
    try testing.expectEqual(null, parseTest(&.{ "serve", "a.db" }, .{}).run.command.serve.open);
}

test "booleans from env follow usage's rules" {
    const env: TestEnv = .{ .pairs = &.{.{ "ZETTA_READ_ONLY", "yes" }} };
    try testing.expect(parseTest(&.{ "serve", "a.db" }, env).run.command.serve.read_only);
    const bad: TestEnv = .{ .pairs = &.{.{ "ZETTA_READ_ONLY", "maybe" }} };
    const f = parseTest(&.{ "serve", "a.db" }, bad).failure;
    try testing.expectEqual(Failure.Kind.invalid_env_value, f.kind);
    try testing.expectEqualStrings("ZETTA_READ_ONLY", f.token);
}

test "a typo in a flag suggests the real one" {
    const f = parseTest(&.{ "serve", "a.db", "--prot", "1" }, .{}).failure;
    try testing.expectEqual(Failure.Kind.unknown_argument, f.kind);
    try testing.expectEqualStrings("--port", f.suggestion.?);
    try testing.expectEqualStrings("zetta serve [OPTIONS] <DSN>", f.usage);
}

test "a typo in a command suggests the real one instead of serving it" {
    const f = parseTest(&.{"qurey"}, .{}).failure;
    try testing.expectEqual(Failure.Kind.unknown_command, f.kind);
    try testing.expectEqualStrings("query", f.suggestion.?);
}

test "missing required positional is reported by its label" {
    const f = parseTest(&.{"query"}, .{}).failure;
    try testing.expectEqual(Failure.Kind.missing_required, f.kind);
    try testing.expectEqualStrings("<DSN>", f.token);
}

test "enum values are checked and listed" {
    const f = parseTest(&.{ "q", "a.db", "select 1", "-f", "xml" }, .{}).failure;
    try testing.expectEqual(Failure.Kind.invalid_value, f.kind);
    try testing.expectEqualStrings("table, json, csv", f.expected);
}

test "a flag missing its value says which value" {
    const f = parseTest(&.{ "serve", "a.db", "--port" }, .{}).failure;
    try testing.expectEqual(Failure.Kind.missing_value, f.kind);
    try testing.expectEqualStrings("PORT", f.expected);
}

test "-- makes the rest positional" {
    const out = parseTest(&.{ "query", "a.db", "--", "-1" }, .{});
    try testing.expectEqualStrings("-1", out.run.command.query.sql.?);
}

test "help, version and hidden builtins" {
    try testing.expectEqual(false, parseTest(&.{"-h"}, .{}).help.long);
    try testing.expectEqualStrings("serve", parseTest(&.{ "serve", "--help" }, .{}).help.command.?);
    try testing.expectEqualStrings("query", parseTest(&.{ "help", "query" }, .{}).help.command.?);
    try testing.expect(parseTest(&.{"--version"}, .{}) == .version);
    try testing.expectEqual(Shell.zsh, parseTest(&.{ "completion", "zsh" }, .{}).completion_script);
    try testing.expectEqual(2, parseTest(&.{ "__complete", "--", "serve", "--p" }, .{}).complete.len);
}

test "completion --help asks for help instead of naming a shell" {
    for ([_][]const []const u8{ &.{ "completion", "--help" }, &.{ "completion", "-h" }, &.{ "completion", "bash", "--help" }, &.{ "help", "completion" } }) |argv| {
        try testing.expectEqualStrings("completion", parseTest(argv, .{}).help.command.?);
    }
    try testing.expectEqual(false, parseTest(&.{ "completion", "-h" }, .{}).help.long);
}

test "edit distance" {
    try testing.expectEqual(0, distance("port", "port"));
    try testing.expectEqual(2, distance("prot", "port"));
    try testing.expectEqual(3, distance("", "abc"));
}
