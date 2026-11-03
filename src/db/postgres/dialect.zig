//! How the filter and sort builder is spelled for Postgres.

const std = @import("std");
const builder = @import("../builder.zig");

fn placeholder(w: *std.Io.Writer, n: usize) std.Io.Writer.Error!void {
    try w.print("${d}", .{n});
}

/// Parameters are sent untyped, so Postgres infers each from the column it meets.
/// Literals assume standard_conforming_strings, the default since 9.1.
pub const dialect: builder.Dialect = .{
    .like = "ILIKE",
    .text_cast = "::text",
    .is_true = " IS TRUE",
    .is_false = " IS FALSE",
    .placeholder = placeholder,
    .quoteIdent = builder.writeDoubleQuoted,
    .quoteLiteral = builder.writeSingleQuoted,
};
