//! Shell completion. The scripts are thin shims that call back into the
//! binary (`<bin> __complete -- <words>`), so they never drift from it. When
//! the binary prints nothing, the shell falls back to file names.

const std = @import("std");
const mem = std.mem;
const Writer = std.Io.Writer;
const spec = @import("spec.zig");
const Shell = @import("parse.zig").Shell;
const Option = spec.Option;

pub fn script(comptime Root: type, shell: Shell, w: *Writer) Writer.Error!void {
    const bin = Root.name;
    switch (shell) {
        .bash => try w.writeAll(
            \\_
        ++ bin ++
            \\() {
            \\    local IFS=$'\n'
            \\    COMPREPLY=($(
        ++ bin ++
            \\ __complete -- "${COMP_WORDS[@]:1:$COMP_CWORD}" 2>/dev/null))
            \\    if [[ ${#COMPREPLY[@]} -eq 0 ]]; then
            \\        COMPREPLY=($(compgen -f -- "${COMP_WORDS[COMP_CWORD]}"))
            \\    fi
            \\}
            \\complete -o filenames -F _
        ++ bin ++ " " ++ bin ++ "\n"),
        .zsh => try w.writeAll(
            \\#compdef
        ++ " " ++ bin ++ "\n" ++
            \\_
        ++ bin ++
            \\() {
            \\    local -a candidates
            \\    candidates=("${(@f)$(
        ++ bin ++
            \\ __complete -- "${(@)words[2,CURRENT]}" 2>/dev/null)}")
            \\    if [[ -n "${candidates[1]}" ]]; then
            \\        compadd -a candidates
            \\    else
            \\        _files
            \\    fi
            \\}
            \\if [[ "${funcstack[1]}" == "_
        ++ bin ++
            \\" ]]; then
            \\    _
        ++ bin ++
            \\ "$@"
            \\else
            \\    compdef _
        ++ bin ++ " " ++ bin ++ "\nfi\n"),
        .fish => try w.writeAll(
            \\function __
        ++ bin ++
            \\_complete
            \\    set -l out (
        ++ bin ++
            \\ __complete -- (commandline -opc)[2..] (commandline -ct) 2>/dev/null)
            \\    if test (count $out) -gt 0
            \\        printf '%s\n' $out
            \\    else
            \\        __fish_complete_path (commandline -ct)
            \\    end
            \\end
            \\complete -c
        ++ " " ++ bin ++ " -f -a '(__" ++ bin ++ "_complete)'\n"),
    }
}

/// Prints one candidate per line for the last of `words` (the word being
/// completed, possibly empty). `words` excludes the binary name.
pub fn candidates(comptime Root: type, words: []const []const u8, w: *Writer) Writer.Error!void {
    const current = if (words.len > 0) words[words.len - 1] else "";
    const before = if (words.len > 0) words[0 .. words.len - 1] else words;

    var command: ?[]const u8 = null;
    for (before) |word| {
        if (word.len > 0 and word[0] == '-') continue;
        inline for (comptime spec.commandFields(Root)) |f| {
            if (mem.eql(u8, word, comptime spec.kebab(f.name))) command = f.name;
            inline for (comptime spec.aliases(f.type)) |alias| {
                if (mem.eql(u8, word, alias)) command = f.name;
            }
        }
        break;
    }

    if (command) |name| {
        inline for (comptime spec.commandFields(Root)) |f| {
            if (mem.eql(u8, f.name, name)) return forCommand(Root, f.type, before, current, w);
        }
    }

    if (before.len > 0) {
        if (try valuesFor(Root, spec.options(Root), before[before.len - 1], current, w)) return;
    }
    if (current.len > 0 and current[0] == '-') {
        try flags(Root, spec.options(Root), current, w);
        try emitIf(w, current, "--help");
        try emitIf(w, current, "--version");
        return;
    }
    inline for (comptime spec.commandFields(Root)) |f| try emitIf(w, current, comptime spec.kebab(f.name));
    try emitIf(w, current, "completion");
    try emitIf(w, current, "help");
}

fn forCommand(comptime Root: type, comptime T: type, before: []const []const u8, current: []const u8, w: *Writer) Writer.Error!void {
    if (before.len > 0) {
        const prev = before[before.len - 1];
        if (try valuesFor(T, spec.options(T), prev, current, w)) return;
        if (try valuesFor(Root, spec.globals(Root), prev, current, w)) return;
    }
    if (current.len > 0 and current[0] == '-') {
        try flags(T, spec.options(T), current, w);
        try flags(Root, spec.globals(Root), current, w);
        try emitIf(w, current, "--help");
        return;
    }
    // An enum positional has choices; anything else falls back to files.
    inline for (comptime spec.options(T)) |o| {
        if (o.positional and comptime spec.choices(T, o).len > 0) {
            inline for (comptime spec.choices(T, o)) |choice| try emitIf(w, current, choice);
        }
    }
}

/// When `prev` is a flag that takes a value, prints that value's choices.
/// Returns true when `prev` takes a value, choices or not.
fn valuesFor(comptime T: type, comptime opts: []const Option, prev: []const u8, current: []const u8, w: *Writer) Writer.Error!bool {
    inline for (opts) |o| {
        if (o.positional or o.hide or comptime !spec.takesValue(T, o)) continue;
        const long = "--" ++ comptime spec.longName(o);
        const short: []const u8 = if (o.short) |s| &[_]u8{ '-', s } else "";
        if (mem.eql(u8, prev, long) or (short.len > 0 and mem.eql(u8, prev, short))) {
            inline for (comptime spec.choices(T, o)) |choice| try emitIf(w, current, choice);
            return true;
        }
    }
    return false;
}

fn flags(comptime T: type, comptime opts: []const Option, current: []const u8, w: *Writer) Writer.Error!void {
    inline for (opts) |o| {
        if (o.positional or o.hide) continue;
        try emitIf(w, current, "--" ++ comptime spec.longName(o));
        if (o.negatable) try emitIf(w, current, "--no-" ++ comptime spec.longName(o));
    }
    _ = T;
}

fn emitIf(w: *Writer, prefix: []const u8, candidate: []const u8) Writer.Error!void {
    if (mem.startsWith(u8, candidate, prefix)) try w.print("{s}\n", .{candidate});
}

const testing = std.testing;

const Sub = struct {
    format: enum { table, json } = .table,
    port: u16 = 0,
    pub const options = [_]Option{
        .{ .field = "format", .short = 'f', .help = "" },
        .{ .field = "port", .help = "" },
    };
};

const Aliased = struct {
    format: enum { table, json } = .table,
    pub const aliases = [_][]const u8{"q"};
    pub const options = [_]Option{.{ .field = "format", .short = 'f', .help = "" }};
};

const Demo = struct {
    verbose: u8 = 0,
    command: Command = undefined,
    pub const name = "demo";
    pub const Command = union(enum) { serve: Sub, query: Aliased };
    pub const options = [_]Option{.{ .field = "verbose", .short = 'v', .count = true, .global = true, .help = "" }};
};

fn expectCandidates(words: []const []const u8, want: []const u8) !void {
    var buf: [512]u8 = undefined;
    var w: Writer = .fixed(&buf);
    try candidates(Demo, words, &w);
    try testing.expectEqualStrings(want, w.buffered());
}

test "the first word completes to commands" {
    try expectCandidates(&.{"s"}, "serve\n");
    try expectCandidates(&.{""}, "serve\nquery\ncompletion\nhelp\n");
}

test "a dash completes to the command's flags plus globals" {
    try expectCandidates(&.{ "serve", "--" }, "--format\n--port\n--verbose\n--help\n");
}

test "a value after an enum flag completes to its choices" {
    try expectCandidates(&.{ "query", "-f", "j" }, "json\n");
}

test "an alias counts as its command" {
    try expectCandidates(&.{ "q", "-f", "" }, "table\njson\n");
}

test "a free-form value prints nothing so the shell offers files" {
    try expectCandidates(&.{ "serve", "--port", "" }, "");
    try expectCandidates(&.{ "serve", "./ap" }, "");
}

test "every script calls back into the binary" {
    inline for (.{ Shell.bash, Shell.zsh, Shell.fish }) |shell| {
        var buf: [1024]u8 = undefined;
        var w: Writer = .fixed(&buf);
        try script(Demo, shell, &w);
        try testing.expect(mem.indexOf(u8, w.buffered(), "demo __complete --") != null);
    }
}
