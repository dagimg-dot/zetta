//! How the filter and sort builder is spelled for SQLite.

const std = @import("std");
const builder = @import("../builder.zig");

fn placeholder(w: *std.Io.Writer, n: usize) std.Io.Writer.Error!void {
    try w.print("?{d}", .{n});
}

/// LIKE is already case-insensitive for ASCII, and a column's affinity turns a
/// bound text value into a number where the column holds numbers.
pub const dialect: builder.Dialect = .{
    .like = "LIKE",
    .text_cast = "",
    .is_true = " = 1",
    .is_false = " = 0",
    .placeholder = placeholder,
    .quoteIdent = builder.writeDoubleQuoted,
    .quoteLiteral = builder.writeSingleQuoted,
};
