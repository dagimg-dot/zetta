//! Reads the few facts SQLite keeps only inside its stored CREATE statements:
//! trigger timing and event, partial-index predicates and expression keys.

const std = @import("std");
const types = @import("../types.zig");

const Token = struct {
    kind: Kind,
    start: usize,
    end: usize,

    const Kind = enum { word, quoted, punct };
};

const Lexer = struct {
    src: []const u8,
    pos: usize = 0,

    fn next(l: *Lexer) ?Token {
        l.skipSpace();
        if (l.pos >= l.src.len) return null;
        const start = l.pos;
        const ch = l.src[start];
        switch (ch) {
            '"', '`', '\'' => {
                l.pos += 1;
                while (l.pos < l.src.len) : (l.pos += 1) {
                    if (l.src[l.pos] != ch) continue;
                    // A doubled quote is an escaped one.
                    if (l.pos + 1 < l.src.len and l.src[l.pos + 1] == ch) {
                        l.pos += 1;
                        continue;
                    }
                    break;
                }
                l.pos = @min(l.pos + 1, l.src.len);
                return .{ .kind = .quoted, .start = start, .end = l.pos };
            },
            '[' => {
                l.pos = if (std.mem.indexOfScalarPos(u8, l.src, start, ']')) |e| e + 1 else l.src.len;
                return .{ .kind = .quoted, .start = start, .end = l.pos };
            },
            else => {
                if (!isWordChar(ch)) {
                    l.pos += 1;
                    return .{ .kind = .punct, .start = start, .end = l.pos };
                }
                while (l.pos < l.src.len and isWordChar(l.src[l.pos])) l.pos += 1;
                return .{ .kind = .word, .start = start, .end = l.pos };
            },
        }
    }

    fn skipSpace(l: *Lexer) void {
        while (l.pos < l.src.len) {
            const rest = l.src[l.pos..];
            if (std.ascii.isWhitespace(rest[0])) {
                l.pos += 1;
            } else if (std.mem.startsWith(u8, rest, "--")) {
                l.pos = if (std.mem.indexOfScalarPos(u8, l.src, l.pos, '\n')) |e| e + 1 else l.src.len;
            } else if (std.mem.startsWith(u8, rest, "/*")) {
                l.pos = if (std.mem.indexOfPos(u8, l.src, l.pos + 2, "*/")) |e| e + 2 else l.src.len;
            } else break;
        }
    }

    /// Consumes the next token when it is the keyword `kw`, ignoring case.
    fn keyword(l: *Lexer, kw: []const u8) bool {
        const saved = l.pos;
        if (l.next()) |t| {
            if (t.kind == .word and std.ascii.eqlIgnoreCase(l.src[t.start..t.end], kw)) return true;
        }
        l.pos = saved;
        return false;
    }

    fn punct(l: *Lexer, ch: u8) bool {
        const saved = l.pos;
        if (l.next()) |t| {
            if (t.kind == .punct and l.src[t.start] == ch) return true;
        }
        l.pos = saved;
        return false;
    }

    /// Moves past the first `(` and returns where the text inside it starts.
    fn openParen(l: *Lexer) ?usize {
        while (l.next()) |t| {
            if (t.kind == .punct and l.src[t.start] == '(') return t.end;
        }
        return null;
    }
};

fn isWordChar(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or ch == '_' or ch == '$' or ch >= 0x80;
}

pub const TriggerHead = struct {
    timing: types.TriggerTiming,
    event: types.TriggerEvent,
};

/// Null when `sql` is not a CREATE TRIGGER statement this parser understands.
/// SQLite triggers have exactly one event, and BEFORE is the default timing.
pub fn triggerHead(sql: []const u8) ?TriggerHead {
    var l: Lexer = .{ .src = sql };
    if (!l.keyword("CREATE")) return null;
    _ = l.keyword("TEMP") or l.keyword("TEMPORARY");
    if (!l.keyword("TRIGGER")) return null;
    if (l.keyword("IF") and !(l.keyword("NOT") and l.keyword("EXISTS"))) return null;
    _ = l.next() orelse return null;
    if (l.punct('.')) _ = l.next() orelse return null;

    var timing: types.TriggerTiming = .before;
    if (l.keyword("BEFORE")) {
        timing = .before;
    } else if (l.keyword("AFTER")) {
        timing = .after;
    } else if (l.keyword("INSTEAD")) {
        if (!l.keyword("OF")) return null;
        timing = .instead_of;
    }
    const event: types.TriggerEvent = if (l.keyword("INSERT"))
        .insert
    else if (l.keyword("UPDATE"))
        .update
    else if (l.keyword("DELETE"))
        .delete
    else
        return null;
    return .{ .timing = timing, .event = event };
}

/// The condition after WHERE in a CREATE INDEX statement, as written.
pub fn indexPredicate(sql: []const u8) ?[]const u8 {
    var l: Lexer = .{ .src = sql };
    _ = l.openParen() orelse return null;
    var depth: usize = 1;
    while (depth > 0) {
        const t = l.next() orelse return null;
        if (t.kind != .punct) continue;
        switch (sql[t.start]) {
            '(' => depth += 1,
            ')' => depth -= 1,
            else => {},
        }
    }
    if (!l.keyword("WHERE")) return null;
    const rest = std.mem.trim(u8, sql[l.pos..], " \t\r\n;");
    return if (rest.len > 0) rest else null;
}

/// Key `n` (from 0) of a CREATE INDEX statement as written, for keys that are expressions.
pub fn indexKey(sql: []const u8, n: usize) ?[]const u8 {
    var l: Lexer = .{ .src = sql };
    var start = l.openParen() orelse return null;
    var depth: usize = 1;
    var k: usize = 0;
    while (l.next()) |t| {
        if (t.kind != .punct) continue;
        switch (sql[t.start]) {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if (depth > 0) continue;
                return if (k == n) std.mem.trim(u8, sql[start..t.start], " \t\r\n") else null;
            },
            ',' => {
                if (depth != 1) continue;
                if (k == n) return std.mem.trim(u8, sql[start..t.start], " \t\r\n");
                k += 1;
                start = t.end;
            },
            else => {},
        }
    }
    return null;
}

const testing = std.testing;

test "trigger timing and event are read case-insensitively" {
    const h = triggerHead("create trigger t_touch after update of qty on t for each row begin select 1; end").?;
    try testing.expectEqual(types.TriggerTiming.after, h.timing);
    try testing.expectEqual(types.TriggerEvent.update, h.event);

    const v = triggerHead("CREATE TEMP TRIGGER IF NOT EXISTS main.\"Instead\" INSTEAD OF DELETE ON v BEGIN SELECT 1; END").?;
    try testing.expectEqual(types.TriggerTiming.instead_of, v.timing);
    try testing.expectEqual(types.TriggerEvent.delete, v.event);
}

test "a trigger without a timing is BEFORE" {
    const h = triggerHead("CREATE TRIGGER [before] /* x */ INSERT ON t BEGIN SELECT 1; END").?;
    try testing.expectEqual(types.TriggerTiming.before, h.timing);
    try testing.expectEqual(types.TriggerEvent.insert, h.event);
}

test "a statement that is not a trigger has no head" {
    try testing.expect(triggerHead("CREATE TABLE t (x)") == null);
}

test "a partial index predicate is the text after WHERE" {
    try testing.expectEqualStrings("qty < 10", indexPredicate("CREATE INDEX i ON t (qty, lower(x)) WHERE qty < 10").?);
    try testing.expectEqualStrings("a = '(;'", indexPredicate("create index \"i(\" on t(a) where a = '(;';").?);
    try testing.expect(indexPredicate("CREATE INDEX i ON t (qty)") == null);
}

test "expression keys come back as written" {
    const sql = "CREATE INDEX i ON t (a, lower(b, 'x,y') DESC, c)";
    try testing.expectEqualStrings("a", indexKey(sql, 0).?);
    try testing.expectEqualStrings("lower(b, 'x,y') DESC", indexKey(sql, 1).?);
    try testing.expectEqualStrings("c", indexKey(sql, 2).?);
    try testing.expect(indexKey(sql, 3) == null);
}
