//! Which requests zetta answers, judged by headers a web page cannot set for itself.
//!
//! The session cookie keeps other sites out, with two gaps. A name an attacker owns can be
//! repointed at this machine (DNS rebinding), which makes their page same-origin with zetta;
//! `Host` gives that away. And SameSite treats every port of a host as one site, so a page served
//! by something else on this machine still gets the cookie sent; `Origin` and `Sec-Fetch-Site`
//! give that away.

const std = @import("std");
const ascii = std.ascii;
const mem = std.mem;
const Request = std.http.Server.Request;

pub const Refusal = struct {
    code: []const u8,
    message: []const u8,
};

const bad_host: Refusal = .{
    .code = "host_not_allowed",
    .message = "zetta does not answer to this host name. To reach it by name, start it with --allowed-hosts <name>.",
};

const bad_caller: Refusal = .{
    .code = "origin_not_allowed",
    .message = "this request came from another page, and only zetta's own page may use its API",
};

/// Why this request must not be answered, or null when it may be. `allowed_hosts` is the
/// `--allowed-hosts` list as given.
pub fn refusal(req: *const Request, allowed_hosts: []const u8, path: []const u8) ?Refusal {
    var host: ?[]const u8 = null;
    var origin: ?[]const u8 = null;
    var fetch_site: ?[]const u8 = null;
    var it = req.iterateHeaders();
    while (it.next()) |h| {
        if (ascii.eqlIgnoreCase(h.name, "host")) {
            if (host != null) return bad_host;
            host = h.value;
        } else if (ascii.eqlIgnoreCase(h.name, "origin")) {
            origin = h.value;
        } else if (ascii.eqlIgnoreCase(h.name, "sec-fetch-site")) {
            fetch_site = h.value;
        }
    }
    const authority = host orelse return bad_host;
    if (!hostAllowed(authority, allowed_hosts)) return bad_host;
    if (mem.startsWith(u8, path, "/api/") and !callerAllowed(origin, fetch_site, authority, allowed_hosts)) return bad_caller;
    return null;
}

/// IP addresses and localhost pass, since DNS rebinding always arrives under a name, as Vite
/// decides for its dev server. Any other name must be listed.
fn hostAllowed(authority: []const u8, allowed_hosts: []const u8) bool {
    const name = hostname(authority) orelse return false;
    return isAddress(name) or isLocalName(name) or listed(allowed_hosts, name) or listed(allowed_hosts, authority);
}

/// A browser sends `Origin` on anything that is not a plain GET, and `Sec-Fetch-Site` on every
/// request to a loopback or https address. A client that sends neither is not a browser, so it
/// has no ambient cookie to abuse.
fn callerAllowed(origin: ?[]const u8, fetch_site: ?[]const u8, host: []const u8, allowed_hosts: []const u8) bool {
    if (fetch_site) |site| {
        if (!mem.eql(u8, site, "same-origin") and !mem.eql(u8, site, "none")) return false;
    }
    const sent = origin orelse return true;
    const scheme_end = mem.indexOf(u8, sent, "://") orelse return false;
    const authority = sent[scheme_end + "://".len ..];
    return ascii.eqlIgnoreCase(authority, host) or listed(allowed_hosts, authority);
}

/// The name in `name`, `name:port` or `[v6]:port`, or null when it is not of that shape.
fn hostname(authority: []const u8) ?[]const u8 {
    if (mem.startsWith(u8, authority, "[")) {
        const close = mem.indexOfScalar(u8, authority, ']') orelse return null;
        return if (isPortSuffix(authority[close + 1 ..])) authority[1..close] else null;
    }
    const colon = mem.indexOfScalar(u8, authority, ':') orelse return authority;
    return if (isPortSuffix(authority[colon..])) authority[0..colon] else null;
}

fn isPortSuffix(s: []const u8) bool {
    if (s.len == 0) return true;
    if (s[0] != ':') return false;
    for (s[1..]) |ch| if (!ascii.isDigit(ch)) return false;
    return true;
}

fn isAddress(name: []const u8) bool {
    _ = std.Io.net.IpAddress.parse(name, 0) catch return false;
    return true;
}

/// RFC 6761 keeps these names on this machine, so no outside party can own one.
fn isLocalName(name: []const u8) bool {
    return ascii.eqlIgnoreCase(name, "localhost") or ascii.endsWithIgnoreCase(name, ".localhost");
}

fn listed(allowed_hosts: []const u8, name: []const u8) bool {
    var entries = mem.tokenizeAny(u8, allowed_hosts, ", ");
    while (entries.next()) |entry| {
        if (ascii.eqlIgnoreCase(entry, name)) return true;
    }
    return false;
}

const testing = std.testing;

test "IP addresses and localhost are answered, with or without a port" {
    for ([_][]const u8{
        "127.0.0.1",   "127.0.0.1:1993",    "127.1.2.3:80",   "192.168.1.4:1993",
        "[::1]",       "[::1]:1993",        "localhost",      "localhost:8080",
        "LocalHost:1", "zetta.localhost:1", "[fe80::1]:1993",
    }) |h| try testing.expect(hostAllowed(h, ""));
}

test "a name that only looks local is refused" {
    for ([_][]const u8{
        "evil.example",  "evil.example:1993",   "127.0.0.1.evil.example", "localhost.evil.example",
        "evillocalhost", "localhost.",          "1.2.3.4.nip.io:1993",    "",
        ":1993",         "localhost:http",      "::1",                    "[::1",
        "[::1]x",        "[evil.example]:1993",
    }) |h| try testing.expect(!hostAllowed(h, ""));
}

test "a listed name is answered on any port, ignoring case" {
    const allowed = "db.internal, Zetta.example.com";
    try testing.expect(hostAllowed("db.internal", allowed));
    try testing.expect(hostAllowed("db.internal:1993", allowed));
    try testing.expect(hostAllowed("ZETTA.example.com:443", allowed));
    try testing.expect(!hostAllowed("other.internal", allowed));
    try testing.expect(!hostAllowed("sub.db.internal", allowed));
}

test "zetta's own page may call the API" {
    const host = "127.0.0.1:1993";
    try testing.expect(callerAllowed("http://127.0.0.1:1993", "same-origin", host, ""));
    try testing.expect(callerAllowed(null, "same-origin", host, ""));
}

test "a URL typed in the address bar and clients that are not browsers may call the API" {
    const host = "127.0.0.1:1993";
    try testing.expect(callerAllowed(null, "none", host, ""));
    try testing.expect(callerAllowed(null, null, host, ""));
}

test "another port on this machine counts as another page" {
    const host = "127.0.0.1:1993";
    try testing.expect(!callerAllowed("http://127.0.0.1:3000", null, host, ""));
    try testing.expect(!callerAllowed(null, "same-site", host, ""));
    try testing.expect(!callerAllowed(null, "cross-site", host, ""));
}

test "an origin that names no host is refused" {
    try testing.expect(!callerAllowed("null", null, "127.0.0.1:1993", ""));
}

test "a proxy that rewrites Host keeps working when its public name is listed" {
    const backend = "127.0.0.1:1993";
    try testing.expect(callerAllowed("https://db.example.com", "same-origin", backend, "db.example.com"));
    try testing.expect(!callerAllowed("https://db.example.com:8443", "same-origin", backend, "db.example.com"));
    try testing.expect(!callerAllowed("https://evil.example", "same-origin", backend, "db.example.com"));
}
