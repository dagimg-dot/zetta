//! The Postgres frontend/backend protocol, version 3.0: building frontend messages
//! and reading backend ones. No I/O here.
//! https://www.postgresql.org/docs/current/protocol-message-formats.html

const std = @import("std");
const mem = std.mem;
const Allocator = mem.Allocator;

pub const protocol_version: u32 = 3 << 16;
pub const ssl_request_code: u32 = 80877103;

pub const Error = error{ProtocolViolation};

/// Frontend messages are built into one buffer and written in one go.
pub const Out = struct {
    list: std.ArrayList(u8) = .empty,

    pub fn reset(o: *Out) void {
        o.list.clearRetainingCapacity();
    }

    pub fn bytes(o: *const Out) []const u8 {
        return o.list.items;
    }

    pub fn deinit(o: *Out, gpa: Allocator) void {
        o.list.deinit(gpa);
    }

    fn begin(o: *Out, gpa: Allocator, tag: ?u8) Allocator.Error!usize {
        if (tag) |t| try o.list.append(gpa, t);
        const at = o.list.items.len;
        try o.list.appendSlice(gpa, &.{ 0, 0, 0, 0 });
        return at;
    }

    fn finish(o: *Out, at: usize) void {
        const len: u32 = @intCast(o.list.items.len - at);
        mem.writeInt(u32, o.list.items[at..][0..4], len, .big);
    }

    fn int32(o: *Out, gpa: Allocator, v: u32) Allocator.Error!void {
        var b: [4]u8 = undefined;
        mem.writeInt(u32, &b, v, .big);
        try o.list.appendSlice(gpa, &b);
    }

    fn int16(o: *Out, gpa: Allocator, v: u16) Allocator.Error!void {
        var b: [2]u8 = undefined;
        mem.writeInt(u16, &b, v, .big);
        try o.list.appendSlice(gpa, &b);
    }

    fn cstr(o: *Out, gpa: Allocator, s: []const u8) Allocator.Error!void {
        try o.list.appendSlice(gpa, s);
        try o.list.append(gpa, 0);
    }

    pub fn sslRequest(o: *Out, gpa: Allocator) Allocator.Error!void {
        const at = try o.begin(gpa, null);
        try o.int32(gpa, ssl_request_code);
        o.finish(at);
    }

    pub fn startup(o: *Out, gpa: Allocator, params: []const [2][]const u8) Allocator.Error!void {
        const at = try o.begin(gpa, null);
        try o.int32(gpa, protocol_version);
        for (params) |p| {
            try o.cstr(gpa, p[0]);
            try o.cstr(gpa, p[1]);
        }
        try o.list.append(gpa, 0);
        o.finish(at);
    }

    pub fn password(o: *Out, gpa: Allocator, pw: []const u8) Allocator.Error!void {
        const at = try o.begin(gpa, 'p');
        try o.cstr(gpa, pw);
        o.finish(at);
    }

    pub fn saslInitial(o: *Out, gpa: Allocator, mechanism: []const u8, data: []const u8) Allocator.Error!void {
        const at = try o.begin(gpa, 'p');
        try o.cstr(gpa, mechanism);
        try o.int32(gpa, @intCast(data.len));
        try o.list.appendSlice(gpa, data);
        o.finish(at);
    }

    pub fn saslResponse(o: *Out, gpa: Allocator, data: []const u8) Allocator.Error!void {
        const at = try o.begin(gpa, 'p');
        try o.list.appendSlice(gpa, data);
        o.finish(at);
    }

    pub fn query(o: *Out, gpa: Allocator, sql: []const u8) Allocator.Error!void {
        const at = try o.begin(gpa, 'Q');
        try o.cstr(gpa, sql);
        o.finish(at);
    }

    /// Parse, Bind (text parameters, text results), Describe portal, Execute, Sync.
    /// Parse, Bind, Describe, Execute and Sync for the unnamed statement. A nonzero `max_rows`
    /// makes Postgres stop there and send PortalSuspended instead of CommandComplete.
    pub fn extendedQuery(o: *Out, gpa: Allocator, sql: []const u8, params: []const ?[]const u8, max_rows: u32) Allocator.Error!void {
        var at = try o.begin(gpa, 'P');
        try o.cstr(gpa, "");
        try o.cstr(gpa, sql);
        try o.int16(gpa, 0);
        o.finish(at);

        at = try o.begin(gpa, 'B');
        try o.cstr(gpa, "");
        try o.cstr(gpa, "");
        try o.int16(gpa, 0);
        try o.int16(gpa, @intCast(params.len));
        for (params) |p| {
            if (p) |v| {
                try o.int32(gpa, @intCast(v.len));
                try o.list.appendSlice(gpa, v);
            } else {
                try o.int32(gpa, 0xffff_ffff);
            }
        }
        try o.int16(gpa, 0);
        o.finish(at);

        at = try o.begin(gpa, 'D');
        try o.list.append(gpa, 'P');
        try o.cstr(gpa, "");
        o.finish(at);

        at = try o.begin(gpa, 'E');
        try o.cstr(gpa, "");
        try o.int32(gpa, @bitCast(max_rows));
        o.finish(at);

        at = try o.begin(gpa, 'S');
        o.finish(at);
    }

    pub fn copyFail(o: *Out, gpa: Allocator, reason: []const u8) Allocator.Error!void {
        const at = try o.begin(gpa, 'f');
        try o.cstr(gpa, reason);
        o.finish(at);
    }

    pub fn terminate(o: *Out, gpa: Allocator) Allocator.Error!void {
        const at = try o.begin(gpa, 'X');
        o.finish(at);
    }
};

/// Reads fields out of one backend message body.
pub const Cursor = struct {
    body: []const u8,
    pos: usize = 0,

    pub fn int32(c: *Cursor) Error!i32 {
        if (c.pos + 4 > c.body.len) return error.ProtocolViolation;
        defer c.pos += 4;
        return mem.readInt(i32, c.body[c.pos..][0..4], .big);
    }

    pub fn int16(c: *Cursor) Error!i16 {
        if (c.pos + 2 > c.body.len) return error.ProtocolViolation;
        defer c.pos += 2;
        return mem.readInt(i16, c.body[c.pos..][0..2], .big);
    }

    pub fn byte(c: *Cursor) Error!u8 {
        if (c.pos >= c.body.len) return error.ProtocolViolation;
        defer c.pos += 1;
        return c.body[c.pos];
    }

    pub fn cstr(c: *Cursor) Error![]const u8 {
        const end = mem.indexOfScalarPos(u8, c.body, c.pos, 0) orelse return error.ProtocolViolation;
        defer c.pos = end + 1;
        return c.body[c.pos..end];
    }

    pub fn take(c: *Cursor, n: usize) Error![]const u8 {
        if (c.pos + n > c.body.len) return error.ProtocolViolation;
        defer c.pos += n;
        return c.body[c.pos..][0..n];
    }

    pub fn rest(c: *Cursor) []const u8 {
        defer c.pos = c.body.len;
        return c.body[c.pos..];
    }
};

pub const Field = struct {
    name: []const u8,
    type_oid: u32,
};

/// RowDescription ('T'): the result's columns.
pub fn rowDescription(arena: Allocator, body: []const u8) (Error || Allocator.Error)![]Field {
    var c: Cursor = .{ .body = body };
    const n: usize = @intCast(@max(0, try c.int16()));
    const fields = try arena.alloc(Field, n);
    for (fields) |*f| {
        const name = try c.cstr();
        _ = try c.int32(); // table oid
        _ = try c.int16(); // column number
        const oid: u32 = @bitCast(try c.int32());
        _ = try c.int16(); // type size
        _ = try c.int32(); // type modifier
        _ = try c.int16(); // format
        f.* = .{ .name = try arena.dupe(u8, name), .type_oid = oid };
    }
    return fields;
}

/// DataRow ('D'), copied into the arena. NULL is null.
pub fn dataRow(arena: Allocator, body: []const u8, columns: usize) (Error || Allocator.Error)![]?[]const u8 {
    var c: Cursor = .{ .body = body };
    const n: usize = @intCast(@max(0, try c.int16()));
    if (n != columns) return error.ProtocolViolation;
    const cells = try arena.alloc(?[]const u8, n);
    for (cells) |*cell| {
        const len = try c.int32();
        cell.* = if (len < 0) null else try arena.dupe(u8, try c.take(@intCast(len)));
    }
    return cells;
}

/// ErrorResponse ('E') and NoticeResponse ('N') fields.
pub const Notice = struct {
    severity: []const u8 = "ERROR",
    code: []const u8 = "",
    message: []const u8 = "",
    detail: ?[]const u8 = null,
    hint: ?[]const u8 = null,
    /// 1-based character position in the query text.
    position: ?usize = null,
    context: ?[]const u8 = null,
    /// The server function that raised it, which names an error in any lc_messages.
    routine: []const u8 = "",

    pub fn parse(body: []const u8) Notice {
        var n: Notice = .{};
        var c: Cursor = .{ .body = body };
        while (c.byte()) |kind| {
            if (kind == 0) break;
            const value = c.cstr() catch break;
            switch (kind) {
                'V' => n.severity = value,
                'S' => if (n.severity.ptr == @as([]const u8, "ERROR").ptr) {
                    n.severity = value;
                },
                'C' => n.code = value,
                'M' => n.message = value,
                'D' => n.detail = value,
                'H' => n.hint = value,
                'P' => n.position = std.fmt.parseInt(usize, value, 10) catch null,
                'W' => n.context = value,
                'R' => n.routine = value,
                else => {},
            }
        } else |_| {}
        return n;
    }

    /// "cannot insert multiple commands into a prepared statement": the text holds more than one.
    pub fn multipleCommands(n: Notice) bool {
        return mem.eql(u8, n.code, "42601") and mem.eql(u8, n.routine, "exec_parse_message");
    }

    /// The message as libpq's default verbosity renders it, including the
    /// "LINE n:" excerpt with a caret under the error position.
    pub fn format(n: Notice, query_text: ?[]const u8, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.print("{s}:  {s}\n", .{ n.severity, n.message });
        if (n.position) |pos| if (query_text) |q| try writePosition(q, pos, w);
        if (n.detail) |d| try w.print("DETAIL:  {s}\n", .{d});
        if (n.hint) |h| try w.print("HINT:  {s}\n", .{h});
        if (n.context) |ctx| try w.print("CONTEXT:  {s}\n", .{ctx});
    }
};

/// "LINE 2: selec 1" and a caret under the character at `pos` (1-based, in characters).
fn writePosition(query: []const u8, pos: usize, w: *std.Io.Writer) std.Io.Writer.Error!void {
    var line_no: usize = 1;
    var line_start: usize = 0;
    var chars: usize = 0;
    var i: usize = 0;
    var caret_byte: usize = query.len;
    while (i < query.len) {
        if (chars + 1 == pos) {
            caret_byte = i;
            break;
        }
        const len = std.unicode.utf8ByteSequenceLength(query[i]) catch 1;
        if (query[i] == '\n') {
            line_no += 1;
            line_start = i + 1;
        }
        i += len;
        chars += 1;
    }
    if (caret_byte > query.len) caret_byte = query.len;
    const line_end = mem.indexOfScalarPos(u8, query, caret_byte, '\n') orelse query.len;
    const line = mem.trimEnd(u8, query[line_start..line_end], "\r");
    const prefix = std.fmt.count("LINE {d}: ", .{line_no});
    try w.print("LINE {d}: {s}\n", .{ line_no, line });
    const col = std.unicode.utf8CountCodepoints(query[line_start..caret_byte]) catch caret_byte - line_start;
    try w.splatByteAll(' ', prefix + col);
    try w.writeAll("^\n");
}

/// Rows a command changed or returned, from its tag ("INSERT 0 3", "UPDATE 2"), as PQcmdTuples reads it.
pub fn tagRows(tag: []const u8) u64 {
    const verbs = [_][]const u8{ "INSERT ", "UPDATE ", "DELETE ", "MERGE ", "SELECT ", "MOVE ", "FETCH ", "COPY " };
    for (verbs) |v| {
        if (mem.startsWith(u8, tag, v)) {
            const last = mem.lastIndexOfScalar(u8, tag, ' ') orelse return 0;
            return std.fmt.parseInt(u64, tag[last + 1 ..], 10) catch 0;
        }
    }
    return 0;
}

const testing = std.testing;

test "startup message layout" {
    var out: Out = .{};
    defer out.deinit(testing.allocator);
    try out.startup(testing.allocator, &.{.{ "user", "jd" }});
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 17, 0, 3, 0, 0, 'u', 's', 'e', 'r', 0, 'j', 'd', 0, 0 }, out.bytes());
}

test "ssl request is the magic code" {
    var out: Out = .{};
    defer out.deinit(testing.allocator);
    try out.sslRequest(testing.allocator);
    try testing.expectEqualSlices(u8, &.{ 0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f }, out.bytes());
}

test "extended query sends parse, bind, describe, execute and sync" {
    var out: Out = .{};
    defer out.deinit(testing.allocator);
    try out.extendedQuery(testing.allocator, "select $1", &.{ "x", null }, 5001);
    const b = out.bytes();
    try testing.expectEqual('P', b[0]);
    try testing.expectEqualSlices(u8, &.{ 'S', 0, 0, 0, 4 }, b[b.len - 5 ..]);
    // Execute names the unnamed portal and carries the row limit.
    try testing.expectEqualSlices(u8, &.{ 'E', 0, 0, 0, 9, 0, 0, 0, 0x13, 0x89 }, b[b.len - 15 .. b.len - 5]);
    // Bind carries one 1-byte value and one NULL (-1).
    try testing.expect(mem.indexOf(u8, b, &.{ 0, 2, 0, 0, 0, 1, 'x', 0xff, 0xff, 0xff, 0xff }) != null);
}

test "row description and data rows decode, NULL included" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const desc = [_]u8{ 0, 1, 'i', 'd', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 23, 0, 4, 0xff, 0xff, 0xff, 0xff, 0, 0 };
    const fields = try rowDescription(arena, &desc);
    try testing.expectEqualStrings("id", fields[0].name);
    try testing.expectEqual(23, fields[0].type_oid);
    const row = [_]u8{ 0, 2, 0, 0, 0, 1, '7', 0xff, 0xff, 0xff, 0xff };
    const cells = try dataRow(arena, &row, 2);
    try testing.expectEqualStrings("7", cells[0].?);
    try testing.expectEqual(null, cells[1]);
    try testing.expectError(error.ProtocolViolation, dataRow(arena, row[0..5], 2));
}

test "errors render like libpq, with the caret on the right line" {
    const body = "SERROR\x00VERROR\x00C42601\x00Msyntax error at or near \"selec\"\x00P11\x00\x00";
    const n = Notice.parse(body);
    try testing.expectEqualStrings("42601", n.code);
    var buf: [256]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try n.format("select 1;\nselec 2", &w);
    try testing.expectEqualStrings(
        \\ERROR:  syntax error at or near "selec"
        \\LINE 2: selec 2
        \\        ^
        \\
    , w.buffered());
}

test "the multiple-commands error is told apart from other syntax errors" {
    const multi = Notice.parse("SERROR\x00C42601\x00Mcannot insert multiple commands into a prepared statement\x00Rexec_parse_message\x00\x00");
    try testing.expect(multi.multipleCommands());
    const typo = Notice.parse("SERROR\x00C42601\x00Msyntax error at or near \"selec\"\x00Rscanner_yyerror\x00\x00");
    try testing.expect(!typo.multipleCommands());
}

test "command tags give the affected row count" {
    try testing.expectEqual(3, tagRows("INSERT 0 3"));
    try testing.expectEqual(2, tagRows("UPDATE 2"));
    try testing.expectEqual(5, tagRows("SELECT 5"));
    try testing.expectEqual(0, tagRows("CREATE TABLE"));
}
