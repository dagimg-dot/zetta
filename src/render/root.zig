//! Turns db values into bytes: JSON for the API and `--format json`, text
//! tables and CSV for the terminal. Knows nothing about HTTP.

pub const json = @import("json.zig");
pub const text = @import("text.zig");

test {
    _ = @import("json.zig");
    _ = @import("text.zig");
    _ = @import("utf8.zig");
}
