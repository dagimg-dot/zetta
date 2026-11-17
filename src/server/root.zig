//! The HTTP side: serves the embedded UI and the JSON API over a db.Adapter.
//! Never names a concrete database.

pub const Server = @import("Server.zig");
pub const auth = @import("auth.zig");
pub const net = @import("net.zig");

const handlers = @import("handlers.zig");
pub const Context = handlers.Context;
pub const serveBytes = handlers.serveBytes;

test {
    _ = @import("http.zig");
    _ = @import("auth.zig");
    _ = @import("guard.zig");
    _ = @import("handlers.zig");
    _ = @import("net.zig");
    _ = @import("q.zig");
    _ = @import("Server.zig");
}
