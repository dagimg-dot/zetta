//! `-h` and `--help`, and how a parse failure is shown. The layout follows
//! clap, so it reads like every other modern CLI.

const std = @import("std");
const Writer = std.Io.Writer;
const spec = @import("spec.zig");
const parse = @import("parse.zig");
const Option = spec.Option;

pub const Style = struct {
    color: bool,

    fn heading(s: Style, w: *Writer, text: []const u8) Writer.Error!void {
        if (s.color) try w.print("\x1b[1;4m{s}\x1b[0m", .{text}) else try w.writeAll(text);
    }

    fn strong(s: Style, w: *Writer, text: []const u8) Writer.Error!void {
        if (s.color) try w.print("\x1b[1m{s}\x1b[0m", .{text}) else try w.writeAll(text);
    }

    fn err(s: Style, w: *Writer) Writer.Error!void {
        if (s.color) try w.writeAll("\x1b[1;31merror:\x1b[0m") else try w.writeAll("error:");
    }
};

pub fn render(comptime Root: type, req: parse.HelpRequest, w: *Writer, style: Style) Writer.Error!void {
    if (req.command) |name| {
        inline for (comptime spec.commandFields(Root)) |f| {
            if (std.mem.eql(u8, f.name, name)) return renderCommand(Root, f.type, f.name, req.long, w, style);
        }
    }
    return renderCommand(Root, Root, null, req.long, w, style);
}

fn renderCommand(comptime Root: type, comptime T: type, comptime name: ?[]const u8, long: bool, w: *Writer, style: Style) Writer.Error!void {
    const about = comptime spec.about(T);
    if (about.len > 0) try w.print("{s}\n\n", .{if (long) about else comptime spec.firstParagraph(about)});

    try style.heading(w, "Usage:");
    try w.print(" {s}\n", .{comptime spec.usageLine(Root.name, name, T)});

    if (name == null and spec.hasCommands(Root)) {
        try w.writeByte('\n');
        try style.heading(w, "Commands:");
        try w.writeByte('\n');
        const width = comptime commandWidth(Root);
        inline for (comptime spec.commandFields(Root)) |f| {
            if (comptime @hasDecl(f.type, "hide") and f.type.hide) continue;
            const cmd_name = comptime spec.kebab(f.name);
            try w.writeAll("  ");
            try style.strong(w, cmd_name);
            try w.splatByteAll(' ', width - cmd_name.len + 2);
            try w.writeAll(comptime spec.firstParagraph(spec.about(f.type)));
            if (comptime spec.defaultCommand(Root)) |d| if (comptime std.mem.eql(u8, d, f.name)) try w.writeAll(" (default)");
            try w.writeByte('\n');
        }
        inline for (.{ .{ "completion", "Print a shell completion script (bash, zsh, fish)" }, .{ "help", "Print help for a command" } }) |builtin| {
            try w.writeAll("  ");
            try style.strong(w, builtin[0]);
            try w.splatByteAll(' ', width - builtin[0].len + 2);
            try w.print("{s}\n", .{builtin[1]});
        }
    }

    const positionals = comptime filter(T, spec.options(T), .positional);
    if (positionals.len > 0) {
        try w.writeByte('\n');
        try style.heading(w, "Arguments:");
        try w.writeByte('\n');
        try renderOptions(T, positionals, long, w, style);
    }

    const own = comptime filter(T, spec.options(T), .flag) ++ builtinFlags(name == null);
    try w.writeByte('\n');
    try style.heading(w, "Options:");
    try w.writeByte('\n');
    try renderOptions(T, own, long, w, style);

    if (name != null) {
        const global = comptime filter(Root, spec.globals(Root), .flag);
        if (global.len > 0) {
            try w.writeByte('\n');
            try style.heading(w, "Global options:");
            try w.writeByte('\n');
            try renderOptions(Root, global, long, w, style);
        }
    }

    const examples = comptime spec.examples(T);
    if (long and examples.len > 0) {
        try w.writeByte('\n');
        try style.heading(w, "Examples:");
        try w.writeByte('\n');
        inline for (examples) |e| {
            try w.print("  $ {s}\n", .{e.command});
            if (e.help.len > 0) try w.print("      {s}\n", .{e.help});
        }
    }
}

const Kind = enum { positional, flag };

fn filter(comptime T: type, comptime opts: []const Option, comptime kind: Kind) []const Option {
    _ = T;
    comptime {
        var out: []const Option = &.{};
        for (opts) |o| {
            if (o.hide or o.positional != (kind == .positional)) continue;
            out = out ++ .{o};
        }
        return out;
    }
}

fn builtinFlags(comptime root: bool) []const Option {
    const help: Option = .{ .field = "help", .short = 'h', .help = "Print help (see more with '--help')" };
    const version: Option = .{ .field = "version", .short = 'V', .help = "Print version" };
    return if (root) &.{ help, version } else &.{help};
}

/// `-H, --host <ADDR>` for flags, `<DSN>` for positionals.
fn label(comptime T: type, comptime o: Option) []const u8 {
    comptime {
        if (o.positional) return spec.positionalLabel(o);
        var text: []const u8 = if (o.short) |s| "-" ++ [_]u8{s} ++ ", " else "    ";
        text = text ++ "--" ++ spec.longName(o);
        if (o.negatable) text = text ++ ", --no-" ++ spec.longName(o);
        if (o.count) text = text ++ "...";
        // The builtin flags have no field to look at.
        if (@hasField(T, o.field) and spec.takesValue(T, o)) text = text ++ " <" ++ spec.valueName(o) ++ ">";
        return text;
    }
}

fn suffix(comptime T: type, comptime o: Option) []const u8 {
    comptime {
        if (!@hasField(T, o.field)) return "";
        var text: []const u8 = "";
        const names = spec.choices(T, o);
        if (names.len > 0) {
            text = text ++ " [possible values: " ++ names[0];
            for (names[1..]) |n| text = text ++ ", " ++ n;
            text = text ++ "]";
        }
        if (o.env.len > 0) {
            text = text ++ " [env: " ++ o.env[0];
            for (o.env[1..]) |e| text = text ++ ", " ++ e;
            text = text ++ "]";
        }
        if (spec.defaultText(T, o)) |d| text = text ++ " [default: " ++ d ++ "]";
        return text;
    }
}

fn renderOptions(comptime T: type, comptime opts: []const Option, long: bool, w: *Writer, style: Style) Writer.Error!void {
    @setEvalBranchQuota(10_000); // Grows with every flag a command declares.
    const width = comptime blk: {
        var max: usize = 0;
        for (opts) |o| max = @max(max, label(T, o).len);
        break :blk max;
    };
    inline for (opts) |o| {
        const l = comptime label(T, o);
        try w.writeAll("  ");
        try style.strong(w, l);
        if (long) {
            try w.writeByte('\n');
            var lines = std.mem.splitScalar(u8, o.help ++ comptime suffix(T, o), '\n');
            while (lines.next()) |line| {
                if (line.len == 0) try w.writeByte('\n') else try w.print("          {s}\n", .{line});
            }
            try w.writeByte('\n');
        } else {
            try w.splatByteAll(' ', width - l.len + 2);
            try w.print("{s}{s}\n", .{ comptime spec.firstParagraph(o.help), comptime suffix(T, o) });
        }
    }
}

fn commandWidth(comptime Root: type) usize {
    comptime {
        var max: usize = "completion".len;
        for (spec.commandFields(Root)) |f| max = @max(max, spec.kebab(f.name).len);
        return max;
    }
}

/// Prints a parse failure the way clap does, ending with the usage line.
pub fn renderFailure(f: parse.Failure, w: *Writer, style: Style) Writer.Error!void {
    try style.err(w);
    switch (f.kind) {
        .unknown_argument, .unexpected_argument => try w.print(" unexpected argument '{s}' found\n", .{f.token}),
        .unknown_command => try w.print(" unrecognized subcommand '{s}'\n", .{f.token}),
        .missing_value => try w.print(" a value is required for '{s} <{s}>' but none was supplied\n", .{ f.token, f.expected }),
        .invalid_value => try w.print(" invalid value '{s}'; expected {s}\n", .{ f.token, f.expected }),
        .invalid_env_value => try w.print(" invalid value in environment variable '{s}'; expected {s}\n", .{ f.token, f.expected }),
        .missing_required => try w.print(" the following required arguments were not provided:\n  {s}\n", .{f.token}),
    }
    if (f.suggestion) |s| try w.print("\n  tip: a similar {s} exists: '{s}'\n", .{ if (f.kind == .unknown_command) "subcommand" else "argument", s });
    try w.writeByte('\n');
    try style.heading(w, "Usage:");
    try w.print(" {s}\n\nFor more information, try '--help'.\n", .{f.usage});
}

const testing = std.testing;

const Demo = struct {
    port: u16 = 7777,
    dsn: ?[]const u8 = null,
    pub const about = "Serve it\n\nLonger story.";
    pub const options = [_]Option{
        .{ .field = "dsn", .positional = true, .required = true, .help = "Database" },
        .{ .field = "port", .short = 'p', .env = &.{"DEMO_PORT"}, .help = "Port to use\n\nMore about ports." },
    };
};

const DemoCli = struct {
    verbose: u8 = 0,
    command: Command = undefined,
    pub const name = "demo";
    pub const about = "A demo";
    pub const Command = union(enum) { serve: Demo };
    pub const options = [_]Option{.{ .field = "verbose", .short = 'v', .count = true, .global = true, .help = "More" }};
};

test "short help shows first paragraphs, env and defaults on one line" {
    var buf: [2048]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try render(DemoCli, .{ .command = "serve", .long = false }, &w, .{ .color = false });
    const out = w.buffered();
    try testing.expect(std.mem.indexOf(u8, out, "Serve it\n\nUsage: demo serve [OPTIONS] <DSN>") != null);
    try testing.expect(std.mem.indexOf(u8, out, "-p, --port <PORT>  Port to use [env: DEMO_PORT] [default: 7777]") != null);
    try testing.expect(std.mem.indexOf(u8, out, "More about ports") == null);
    try testing.expect(std.mem.indexOf(u8, out, "Global options:\n  -v, --verbose...") != null);
}

test "long help shows every paragraph" {
    var buf: [2048]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try render(DemoCli, .{ .command = "serve", .long = true }, &w, .{ .color = false });
    try testing.expect(std.mem.indexOf(u8, w.buffered(), "More about ports.") != null);
    try testing.expect(std.mem.indexOf(u8, w.buffered(), "Longer story.") != null);
}

test "failures end with the usage line and a tip" {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try renderFailure(.{ .kind = .unknown_argument, .token = "--prot", .suggestion = "--port", .usage = "demo serve [OPTIONS]" }, &w, .{ .color = false });
    try testing.expectEqualStrings(
        \\error: unexpected argument '--prot' found
        \\
        \\  tip: a similar argument exists: '--port'
        \\
        \\Usage: demo serve [OPTIONS]
        \\
        \\For more information, try '--help'.
        \\
    , w.buffered());
}
