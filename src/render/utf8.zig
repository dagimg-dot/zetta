//! Text from a database is not always valid UTF-8: SQLite never checks TEXT, and an error message
//! cut to a length can end inside a character. These walk such text a character at a time and
//! take each byte that starts no valid character as a character of its own.

const std = @import("std");

/// U+FFFD, written in place of each byte that starts no valid character.
pub const replacement = "\u{FFFD}";

/// The bytes of the character `bytes` starts with, or null when its first byte starts no valid
/// character. `bytes` must not be empty.
pub fn next(bytes: []const u8) ?[]const u8 {
    const n = std.unicode.utf8ByteSequenceLength(bytes[0]) catch return null;
    if (n > bytes.len or !std.unicode.utf8ValidateSlice(bytes[0..n])) return null;
    return bytes[0..n];
}

/// How many characters `bytes` holds, each invalid byte counting as one.
pub fn count(bytes: []const u8) usize {
    return std.unicode.utf8CountCodepoints(bytes) catch countLoose(bytes);
}

fn countLoose(bytes: []const u8) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < bytes.len) : (n += 1) i += if (next(bytes[i..])) |ch| ch.len else 1;
    return n;
}

const testing = std.testing;

test "each byte that starts no character counts as one" {
    try testing.expectEqual(3, count("a\xffb"));
    try testing.expectEqual(2, count("\xe2\x82"));
    try testing.expectEqual(2, count("é€"));
}

test "a character cut short at the end is not a character" {
    try testing.expectEqual(null, next("\xe2\x82"));
    try testing.expectEqualStrings("€", next("€x").?);
}

test "an overlong or surrogate encoding is not a character" {
    try testing.expectEqual(null, next("\xc0\xaf"));
    try testing.expectEqual(null, next("\xed\xa0\x80"));
}
