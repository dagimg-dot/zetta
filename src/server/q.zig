//! The `q` parameter: the UI's filter and sort builder as JSON (see docs/API.md).
//! Only turns it into a `db.builder.Builder`; the adapters compile it.

const std = @import("std");
const Allocator = std.mem.Allocator;
const builder = @import("db").builder;

const Wire = struct {
    match: ?[]const u8 = null,
    filters: []const WireFilter = &.{},
    sorts: []const WireSort = &.{},
};

const WireFilter = struct {
    c: []const u8 = "",
    op: []const u8,
    v: []const u8 = "",
};

const WireSort = struct {
    c: []const u8 = "",
    d: ?[]const u8 = null,
};

pub const Parsed = union(enum) {
    ok: builder.Builder,
    /// Why the request is a 400.
    bad: []const u8,
};

pub fn parse(arena: Allocator, text: []const u8) Allocator.Error!Parsed {
    const wire = std.json.parseFromSliceLeaky(Wire, arena, text, .{ .ignore_unknown_fields = true }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return .{ .bad = try std.fmt.allocPrint(arena, "q is not a filter and sort builder ({t})", .{err}) },
    };
    const filters = try arena.alloc(builder.Filter, wire.filters.len);
    for (filters, wire.filters) |*f, w| {
        const op = std.meta.stringToEnum(builder.Op, w.op) orelse
            return .{ .bad = try std.fmt.allocPrint(arena, "unknown filter operator: {s}", .{w.op}) };
        f.* = .{ .column = w.c, .op = op, .value = w.v };
    }
    const sorts = try arena.alloc(builder.SortKey, wire.sorts.len);
    for (sorts, wire.sorts) |*s, w| {
        s.* = .{ .column = w.c, .desc = if (w.d) |d| std.mem.eql(u8, d, "desc") else false };
    }
    const any = if (wire.match) |m| std.mem.eql(u8, m, "any") else false;
    return .{ .ok = .{ .match = if (any) .any else .all, .filters = filters, .sorts = sorts } };
}

const testing = std.testing;

test "a builder parses with defaults for what is left out" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const p = try parse(arena,
        \\{"match":"any","filters":[{"c":"a","op":"is_null"},{"c":"b","op":"eq","v":"1","extra":true}],"sorts":[{"c":"a","d":"desc"},{"c":"b","d":"sideways"}]}
    );
    const b = p.ok;
    try testing.expectEqual(builder.Match.any, b.match);
    try testing.expectEqual(builder.Op.is_null, b.filters[0].op);
    try testing.expectEqualStrings("", b.filters[0].value);
    try testing.expectEqualStrings("1", b.filters[1].value);
    try testing.expect(b.sorts[0].desc);
    try testing.expect(!b.sorts[1].desc);

    const empty = (try parse(arena, "{}")).ok;
    try testing.expectEqual(builder.Match.all, empty.match);
    try testing.expectEqual(0, empty.filters.len);
}

test "an unknown match is all" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    try testing.expectEqual(builder.Match.all, (try parse(arena_state.allocator(), "{\"match\":\"some\"}")).ok.match);
}

test "malformed JSON, wrong types and unknown operators are refused" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const bad = [_][]const u8{
        "{not json",
        "[]",
        "{\"match\":1}",
        "{\"filters\":{}}",
        "{\"filters\":[{\"c\":\"a\",\"op\":\"eq\",\"v\":1}]}",
        "{\"filters\":[{\"c\":\"a\"}]}",
        "{\"filters\":[{\"c\":\"a\",\"op\":\"drop table\"}]}",
        // An unknown operator is refused even on a row that would be skipped.
        "{\"filters\":[{\"c\":\"\",\"op\":\"like\"}]}",
    };
    for (bad) |text| {
        const p = try parse(arena, text);
        if (p != .bad) {
            std.debug.print("accepted: {s}\n", .{text});
            return error.TestExpectedBad;
        }
    }
    try testing.expectEqualStrings("unknown filter operator: drop table", (try parse(arena, bad[6])).bad);
}
