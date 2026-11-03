const cli = @import("cli");
const db = @import("db");
const render = @import("render");
const common = @import("common.zig");
const Context = @import("Context.zig");

pub const Args = struct {
    dsn: ?[]const u8 = null,
    format: enum { text, json } = .text,

    pub const about = "List schemas and tables";
    pub const aliases = [_][]const u8{"ls"};
    pub const options = [_]cli.Option{
        common.dsn,
        .{ .field = "format", .short = 'f', .help = "Output format" },
    };
};

pub fn run(ctx: *Context, args: Args) !cli.ExitCode {
    const adapter = switch (ctx.openDatabase(args.dsn.?, .{ .read_only = true, .pool_size = 1 })) {
        .ok => |a| a,
        .exit => |code| return code,
    };
    defer adapter.deinit();

    var diag: db.Diagnostic = .{};
    const cat = adapter.catalog(ctx.arena, &diag) catch |err|
        return ctx.fail("{s}", .{if (diag.message().len > 0) diag.message() else @errorName(err)});
    switch (args.format) {
        .text => try render.text.catalog(ctx.stdout, cat),
        .json => {
            try render.json.catalog(ctx.stdout, cat);
            try ctx.stdout.writeByte('\n');
        },
    }
    return .success;
}
