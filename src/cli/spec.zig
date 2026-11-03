//! How a CLI is declared. A command is a struct whose fields hold the parsed
//! values; its `options` decl describes each field. The field type decides
//! the shape, as in jdx's usage-rs:
//!
//! - `bool` is a switch, `?bool` a switch that can also be turned off (`--no-x`)
//! - an integer with `.count = true` counts repeats (`-vvv`)
//! - integers, strings and enums take a value; an enum's tags are its choices
//! - `?T` is unset unless given on the command line, in the env or by default
//!
//! The root struct adds `name`, `about` and optionally `version`,
//! `default_command` and a `Command` union whose payloads are subcommands.
//! One level of subcommands is supported.

const std = @import("std");

pub const Option = struct {
    /// The struct field this option fills.
    field: []const u8,
    /// First paragraph is the short help (`-h`); all of it is the long help (`--help`).
    help: []const u8,
    short: ?u8 = null,
    /// Defaults to the field name with `_` replaced by `-`.
    long: ?[]const u8 = null,
    /// Defaults to the field name in upper case.
    value_name: ?[]const u8 = null,
    /// Checked in order when the command line does not set the option.
    env: []const []const u8 = &.{},
    positional: bool = false,
    required: bool = false,
    /// Also accept `--no-<long>`. Requires a `?bool` or `bool` field.
    negatable: bool = false,
    count: bool = false,
    /// Root options only: accepted before and after the subcommand.
    global: bool = false,
    hide: bool = false,
};

pub const Example = struct {
    command: []const u8,
    help: []const u8 = "",
};

pub fn options(comptime T: type) []const Option {
    return if (@hasDecl(T, "options")) &T.options else &.{};
}

pub fn examples(comptime T: type) []const Example {
    return if (@hasDecl(T, "examples")) &T.examples else &.{};
}

pub fn about(comptime T: type) []const u8 {
    return if (@hasDecl(T, "about")) T.about else "";
}

pub fn aliases(comptime T: type) []const []const u8 {
    return if (@hasDecl(T, "aliases")) &T.aliases else &.{};
}

pub fn hasCommands(comptime Root: type) bool {
    return @hasDecl(Root, "Command");
}

pub fn commandFields(comptime Root: type) []const std.builtin.Type.UnionField {
    return if (hasCommands(Root)) @typeInfo(Root.Command).@"union".fields else &.{};
}

pub fn defaultCommand(comptime Root: type) ?[]const u8 {
    return if (@hasDecl(Root, "default_command")) Root.default_command else null;
}

pub fn globals(comptime Root: type) []const Option {
    comptime {
        var out: []const Option = &.{};
        for (options(Root)) |o| {
            if (o.global) out = out ++ .{o};
        }
        return out;
    }
}

pub fn kebab(comptime field: []const u8) []const u8 {
    comptime {
        var buf: [field.len]u8 = undefined;
        for (field, 0..) |ch, i| buf[i] = if (ch == '_') '-' else ch;
        const final = buf;
        return &final;
    }
}

pub fn longName(comptime o: Option) []const u8 {
    return o.long orelse kebab(o.field);
}

pub fn valueName(comptime o: Option) []const u8 {
    comptime {
        if (o.value_name) |v| return v;
        var buf: [o.field.len]u8 = undefined;
        for (o.field, 0..) |ch, i| buf[i] = std.ascii.toUpper(ch);
        const final = buf;
        return &final;
    }
}

pub fn Unwrapped(comptime F: type) type {
    return switch (@typeInfo(F)) {
        .optional => |opt| opt.child,
        else => F,
    };
}

pub fn ValueType(comptime T: type, comptime o: Option) type {
    return Unwrapped(@FieldType(T, o.field));
}

pub fn takesValue(comptime T: type, comptime o: Option) bool {
    return !o.count and ValueType(T, o) != bool;
}

/// `[DSN]` or `<DSN>` for positionals.
pub fn positionalLabel(comptime o: Option) []const u8 {
    return if (o.required) "<" ++ valueName(o) ++ ">" else "[" ++ valueName(o) ++ "]";
}

pub fn firstParagraph(comptime text: []const u8) []const u8 {
    return if (std.mem.indexOf(u8, text, "\n\n")) |end| text[0..end] else text;
}

pub fn choices(comptime T: type, comptime o: Option) []const []const u8 {
    comptime {
        const V = ValueType(T, o);
        if (@typeInfo(V) != .@"enum") return &.{};
        var out: []const []const u8 = &.{};
        for (@typeInfo(V).@"enum".fields) |f| out = out ++ .{kebab(f.name)};
        return out;
    }
}

/// The field's default as shown in help, or null when there is nothing to show.
pub fn defaultText(comptime T: type, comptime o: Option) ?[]const u8 {
    comptime {
        if (o.count or o.positional) return null;
        const field = for (@typeInfo(T).@"struct".fields) |f| {
            if (std.mem.eql(u8, f.name, o.field)) break f;
        } else unreachable;
        const value = field.defaultValue() orelse return null;
        return switch (@typeInfo(field.type)) {
            .bool, .optional => null,
            .int => std.fmt.comptimePrint("{d}", .{value}),
            .@"enum" => kebab(@tagName(value)),
            .pointer => value,
            else => null,
        };
    }
}

/// `zetta serve [OPTIONS] [DSN]`
pub fn usageLine(comptime bin: []const u8, comptime command: ?[]const u8, comptime T: type) []const u8 {
    comptime {
        var line: []const u8 = bin;
        if (command) |name| line = line ++ " " ++ name;
        line = line ++ " [OPTIONS]";
        for (options(T)) |o| {
            if (o.positional) line = line ++ " " ++ positionalLabel(o);
        }
        if (command == null and hasCommands(T)) line = line ++ " [COMMAND]";
        return line;
    }
}

/// Fails the build when an option names a field that does not exist or a
/// field type the parser cannot fill.
pub fn validate(comptime T: type) void {
    comptime {
        for (options(T)) |o| {
            if (!@hasField(T, o.field)) @compileError(@typeName(T) ++ " has no field '" ++ o.field ++ "'");
            const V = ValueType(T, o);
            switch (@typeInfo(V)) {
                .bool, .int, .@"enum" => {},
                .pointer => if (V != []const u8) @compileError(o.field ++ ": only []const u8 strings are supported"),
                else => @compileError(o.field ++ ": unsupported option type " ++ @typeName(V)),
            }
            if (o.negatable and V != bool) @compileError(o.field ++ ": negatable needs a bool");
            if (o.count and @typeInfo(V) != .int) @compileError(o.field ++ ": count needs an integer");
        }
    }
}
