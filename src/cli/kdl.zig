//! `__spec`: the CLI as a usage KDL spec (https://usage.jdx.dev/spec/), so
//! the `usage` tool can generate docs, man pages and completions from it.

const std = @import("std");
const Writer = std.Io.Writer;
const spec = @import("spec.zig");
const Option = spec.Option;

pub fn write(comptime Root: type, version: []const u8, w: *Writer) Writer.Error!void {
    try w.print("name \"{s}\"\nbin \"{s}\"\nversion \"{s}\"\n", .{ Root.name, Root.name, version });
    if (comptime spec.about(Root).len > 0) try writeString(w, "about ", comptime spec.about(Root), "\n");
    if (comptime spec.defaultCommand(Root)) |d| try w.print("default_subcommand \"{s}\"\n", .{comptime spec.kebab(d)});
    try options(Root, spec.options(Root), "", w);
    inline for (comptime spec.commandFields(Root)) |f| {
        try w.print("cmd \"{s}\"", .{comptime spec.kebab(f.name)});
        try writeString(w, " help=", comptime spec.firstParagraph(spec.about(f.type)), "");
        try w.writeAll(" {\n");
        inline for (comptime spec.aliases(f.type)) |alias| try w.print("    alias \"{s}\"\n", .{alias});
        try options(f.type, spec.options(f.type), "    ", w);
        inline for (comptime spec.examples(f.type)) |e| {
            try writeString(w, "    example ", e.command, "");
            if (e.help.len > 0) try writeString(w, " help=", e.help, "");
            try w.writeByte('\n');
        }
        try w.writeAll("}\n");
    }
}

fn options(comptime T: type, comptime opts: []const Option, indent: []const u8, w: *Writer) Writer.Error!void {
    @setEvalBranchQuota(10_000); // Grows with every flag a command declares.
    inline for (opts) |o| {
        try w.writeAll(indent);
        if (o.positional) {
            try w.print("arg \"{s}\"", .{comptime spec.positionalLabel(o)});
        } else {
            try w.writeAll("flag \"");
            if (o.short) |s| try w.print("-{c} ", .{s});
            try w.print("--{s}", .{comptime spec.longName(o)});
            if (comptime spec.takesValue(T, o)) try w.print(" <{s}>", .{comptime spec.valueName(o)});
            try w.writeByte('"');
        }
        try writeString(w, " help=", comptime spec.firstParagraph(o.help), "");
        if (o.env.len > 0) try w.print(" env=\"{s}\"", .{o.env[0]});
        if (comptime spec.defaultText(T, o)) |d| try w.print(" default=\"{s}\"", .{d});
        if (o.count) try w.writeAll(" count=#true");
        if (o.global) try w.writeAll(" global=#true");
        if (o.hide) try w.writeAll(" hide=#true");
        if (!o.positional and o.required) try w.writeAll(" required=#true");
        if (o.negatable) try w.print(" negate=\"--no-{s}\"", .{comptime spec.longName(o)});
        const names = comptime spec.choices(T, o);
        if (names.len > 0) {
            try w.writeAll(" {\n");
            try w.print("{s}    choices", .{indent});
            inline for (names) |n| try w.print(" \"{s}\"", .{n});
            try w.print("\n{s}}}", .{indent});
        }
        try w.writeByte('\n');
    }
}

fn writeString(w: *Writer, prefix: []const u8, text: []const u8, end: []const u8) Writer.Error!void {
    try w.writeAll(prefix);
    try w.writeByte('"');
    for (text) |ch| switch (ch) {
        '"' => try w.writeAll("\\\""),
        '\\' => try w.writeAll("\\\\"),
        '\n' => try w.writeAll("\\n"),
        else => try w.writeByte(ch),
    };
    try w.writeByte('"');
    try w.writeAll(end);
}

test "flags, args and choices come out as usage KDL" {
    const Sub = struct {
        dsn: ?[]const u8 = null,
        format: enum { table, json } = .table,
        pub const about = "Run SQL";
        pub const options = [_]Option{
            .{ .field = "dsn", .positional = true, .required = true, .env = &.{"ZETTA_DSN"}, .help = "Database" },
            .{ .field = "format", .short = 'f', .help = "Say \"how\"" },
        };
    };
    const Demo = struct {
        command: Command = undefined,
        pub const name = "demo";
        pub const Command = union(enum) { query: Sub };
    };
    var buf: [1024]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try write(Demo, "1.0.0", &w);
    try std.testing.expectEqualStrings(
        \\name "demo"
        \\bin "demo"
        \\version "1.0.0"
        \\cmd "query" help="Run SQL" {
        \\    arg "<DSN>" help="Database" env="ZETTA_DSN"
        \\    flag "-f --format <FORMAT>" help="Say \"how\"" default="table" {
        \\        choices "table" "json"
        \\    }
        \\}
        \\
    , w.buffered());
}
