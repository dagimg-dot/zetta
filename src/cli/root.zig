//! A small comptime CLI framework after jdx's usage: declare commands once,
//! get the parser, help, completions and a usage spec from the declaration.
//! Knows nothing about zetta.

const std = @import("std");

pub const spec = @import("spec.zig");
pub const Option = spec.Option;
pub const Example = spec.Example;

const parse_mod = @import("parse.zig");
pub const parse = parse_mod.parse;
pub const parseBool = parse_mod.parseBool;
pub const Outcome = parse_mod.Outcome;
pub const Failure = parse_mod.Failure;
pub const Shell = parse_mod.Shell;

const help = @import("help.zig");
pub const Style = help.Style;
pub const renderHelp = help.render;
pub const renderFailure = help.renderFailure;

const complete = @import("complete.zig");
pub const completionScript = complete.script;
pub const completionCandidates = complete.candidates;

pub const writeSpec = @import("kdl.zig").write;

pub const ExitCode = enum(u8) {
    success = 0,
    failure = 1,
    usage = 2,
};

test {
    _ = @import("spec.zig");
    _ = @import("parse.zig");
    _ = @import("help.zig");
    _ = @import("complete.zig");
    _ = @import("kdl.zig");
}
