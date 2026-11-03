//! One native Postgres connection: TCP or Unix socket, TLS through std.crypto.tls,
//! startup, authentication and queries. Used by one thread at a time via the pool.

const std = @import("std");
const mem = std.mem;
const Io = std.Io;
const Allocator = mem.Allocator;
const tls = std.crypto.tls;
const Certificate = std.crypto.Certificate;
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Error = types.Error;
const wire = @import("wire.zig");
const auth = @import("auth.zig");
const sql = @import("sql.zig");
const Settings = @import("settings.zig").Settings;

const log = std.log.scoped(.postgres);

const Conn = @This();

state: *State,

/// Trusted roots, loaded once and shared by every connection of an adapter.
pub const Roots = struct {
    lock: Io.RwLock = .init,
    load: Io.Mutex = .init,
    bundle: Certificate.Bundle = .empty,
    loaded: bool = false,

    pub fn deinit(r: *Roots, gpa: Allocator) void {
        r.bundle.deinit(gpa);
    }

    fn ensure(r: *Roots, gpa: Allocator, io: Io, source: ?[]const u8, diag: *Diagnostic) Error!void {
        r.load.lockUncancelable(io);
        defer r.load.unlock(io);
        if (r.loaded) return;
        const now = Io.Clock.real.now(io);
        const path: ?[]const u8 = if (source) |s| (if (mem.eql(u8, s, "system")) null else s) else null;
        if (path) |p| {
            r.bundle.addCertsFromFilePathAbsolute(gpa, io, now, p) catch |err| {
                diag.print("could not read root certificate file \"{s}\": {t}", .{ p, err });
                return error.ConnectFailed;
            };
        } else {
            r.bundle.rescan(gpa, io, now) catch |err| {
                diag.print("could not load the system certificate store: {t}", .{err});
                return error.ConnectFailed;
            };
        }
        r.loaded = true;
    }
};

pub const Config = struct {
    gpa: Allocator,
    io: Io,
    settings: *const Settings,
    roots: *Roots,
};

const buf_len = tls.Client.min_buffer_len;

const State = struct {
    gpa: Allocator,
    io: Io,
    stream: Io.net.Stream,
    net_reader: Io.net.Stream.Reader,
    net_writer: Io.net.Stream.Writer,
    tls_client: tls.Client,
    use_tls: bool,
    broken: bool = false,
    /// From ReadyForQuery: 'I' idle, 'T' in a transaction, 'E' in a failed transaction.
    txn_status: u8 = 'I',
    out: wire.Out = .{},
    /// Messages bigger than the read buffer land here.
    big: std.ArrayList(u8) = .empty,
    type_names: std.AutoHashMapUnmanaged(u32, []u8) = .empty,
    statement_timeout: StatementTimeout = .default,
    net_rbuf: [buf_len]u8,
    net_wbuf: [buf_len]u8,
    tls_rbuf: [buf_len]u8,
    tls_wbuf: [buf_len]u8,

    fn reader(s: *State) *Io.Reader {
        return if (s.use_tls) &s.tls_client.reader else &s.net_reader.interface;
    }

    fn writer(s: *State) *Io.Writer {
        return if (s.use_tls) &s.tls_client.writer else &s.net_writer.interface;
    }

    fn send(s: *State) Io.Writer.Error!void {
        const w = s.writer();
        try w.writeAll(s.out.bytes());
        try w.flush();
        if (s.use_tls) try s.net_writer.interface.flush();
        s.out.reset();
    }

    const Message = struct { tag: u8, body: []const u8 };

    /// The body is valid until the next read.
    fn read(s: *State) Io.Reader.Error!Message {
        const r = s.reader();
        const tag = try r.takeByte();
        const len = try r.takeInt(u32, .big);
        if (len < 4) return error.ReadFailed;
        const n = len - 4;
        if (n <= r.buffer.len) return .{ .tag = tag, .body = try r.take(n) };
        s.big.clearRetainingCapacity();
        s.big.ensureTotalCapacity(s.gpa, n) catch return error.ReadFailed;
        s.big.items.len = n;
        try r.readSliceAll(s.big.items);
        return .{ .tag = tag, .body = s.big.items };
    }

    fn destroy(s: *State) void {
        var it = s.type_names.valueIterator();
        while (it.next()) |v| s.gpa.free(v.*);
        s.type_names.deinit(s.gpa);
        s.out.deinit(s.gpa);
        s.big.deinit(s.gpa);
        s.stream.close(s.io);
        s.gpa.destroy(s);
    }
};

/// What zetta last did to the session's statement_timeout, so an unchanged budget costs no round trip.
const StatementTimeout = union(enum) {
    /// Never set by zetta: whatever the server, database or role says.
    default,
    ms: u32,
    /// Set by zetta, then caller SQL ran, and that can hold a SET of its own.
    unsure,
};

const Ssl = enum { off, if_offered, required };

const AttemptError = Error || error{TlsFailed};

pub fn connect(config: Config, diag: *Diagnostic) Error!Conn {
    const s = config.settings;
    if (s.host == null) return attempt(config, .off, diag) catch |e| narrow(e);
    return switch (s.sslmode) {
        .disable => attempt(config, .off, diag) catch |e| narrow(e),
        .allow => attempt(config, .off, diag) catch |first| switch (first) {
            // libpq retries with SSL when the server turns the plain connection away.
            error.ConnectFailed => attempt(config, .required, diag) catch |e| narrow(e),
            else => narrow(first),
        },
        .prefer => attempt(config, .if_offered, diag) catch |first| switch (first) {
            // A failed handshake falls back to a plain connection, as libpq does.
            error.TlsFailed => attempt(config, .off, diag) catch |e| narrow(e),
            else => narrow(first),
        },
        .require, .verify_ca, .verify_full => attempt(config, .required, diag) catch |e| narrow(e),
    };
}

fn narrow(err: AttemptError) Error {
    return switch (err) {
        error.TlsFailed => error.ConnectFailed,
        else => |e| e,
    };
}

fn attempt(config: Config, ssl: Ssl, diag: *Diagnostic) AttemptError!Conn {
    const gpa = config.gpa;
    const io = config.io;
    const s = config.settings;

    const stream = try openSocket(io, s, diag);
    const st = gpa.create(State) catch {
        stream.close(io);
        return error.OutOfMemory;
    };
    st.* = .{
        .gpa = gpa,
        .io = io,
        .stream = stream,
        .net_reader = undefined,
        .net_writer = undefined,
        .tls_client = undefined,
        .use_tls = false,
        .net_rbuf = undefined,
        .net_wbuf = undefined,
        .tls_rbuf = undefined,
        .tls_wbuf = undefined,
    };
    st.net_reader = stream.reader(io, &st.net_rbuf);
    st.net_writer = stream.writer(io, &st.net_wbuf);
    var conn: Conn = .{ .state = st };
    errdefer {
        st.broken = true;
        conn.close();
    }

    if (ssl != .off) try negotiateTls(conn, config, ssl == .required, diag);
    startup(conn, s, diag) catch |err| {
        // sslmode=prefer: a server that turns the TLS connection away (a hostnossl
        // rule, say) gets a second, plain attempt, as libpq does.
        if (err == error.ConnectFailed and st.use_tls and ssl == .if_offered and !st.broken) return error.TlsFailed;
        return err;
    };
    return conn;
}

fn openSocket(io: Io, s: *const Settings, diag: *Diagnostic) Error!Io.net.Stream {
    const timeout: Io.Timeout = if (s.connect_timeout_s) |t|
        .{ .duration = .{ .raw = Io.Duration.fromSeconds(t), .clock = .awake } }
    else
        .none;

    if (s.host) |host| {
        if (s.hostaddr) |addr_text| {
            const addr = Io.net.IpAddress.parse(addr_text, s.port) catch {
                diag.print("could not parse network address \"{s}\"", .{addr_text});
                return error.ConnectFailed;
            };
            return addr.connect(io, .{ .mode = .stream, .timeout = timeout }) catch |err|
                return connectFailed(diag, addr_text, s.port, err);
        }
        if (Io.net.IpAddress.parse(host, s.port)) |addr| {
            return addr.connect(io, .{ .mode = .stream, .timeout = timeout }) catch |err|
                return connectFailed(diag, host, s.port, err);
        } else |_| {}
        const name = Io.net.HostName.init(host) catch {
            diag.print("could not translate host name \"{s}\" to address: invalid host name", .{host});
            return error.ConnectFailed;
        };
        return name.connect(io, s.port, .{ .mode = .stream, .timeout = timeout }) catch |err| switch (err) {
            error.UnknownHostName,
            error.NoAddressReturned,
            error.NameServerFailure,
            error.ResolvConfParseFailed,
            error.DetectingNetworkConfigurationFailed,
            => {
                diag.print("could not translate host name \"{s}\" to address: {t}", .{ host, err });
                return error.ConnectFailed;
            },
            else => return connectFailed(diag, host, s.port, err),
        };
    }

    var last_path: [256]u8 = undefined;
    var last_len: usize = 0;
    var last_err: anyerror = error.FileNotFound;
    for (s.socket_dirs) |dir| {
        var path_buf: [256]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}/.s.PGSQL.{d}", .{ dir, s.port }) catch continue;
        @memcpy(last_path[0..path.len], path);
        last_len = path.len;
        const addr = Io.net.UnixAddress.init(path) catch continue;
        if (addr.connect(io)) |stream| return stream else |err| last_err = err;
    }
    diag.print("connection to server on socket \"{s}\" failed: {t}", .{ last_path[0..last_len], last_err });
    return error.ConnectFailed;
}

fn connectFailed(diag: *Diagnostic, host: []const u8, port: u16, err: anyerror) Error {
    diag.print("connection to server at \"{s}\", port {d} failed: {t}", .{ host, port, err });
    return error.ConnectFailed;
}

fn negotiateTls(conn: Conn, config: Config, required: bool, diag: *Diagnostic) AttemptError!void {
    const st = conn.state;
    const s = config.settings;
    st.out.sslRequest(st.gpa) catch return error.OutOfMemory;
    st.send() catch return lost(st, diag);
    const answer = st.net_reader.interface.takeByte() catch return lost(st, diag);
    switch (answer) {
        'S' => {},
        'N' => {
            if (required) {
                diag.set("server does not support SSL, but SSL was required");
                return error.ConnectFailed;
            }
            return;
        },
        else => {
            diag.print("received invalid response to SSL negotiation: {c}", .{answer});
            return error.ConnectFailed;
        },
    }

    const verify_chain = s.sslmode == .verify_ca or s.sslmode == .verify_full or
        (s.sslmode == .require and s.sslrootcert != null);
    if (verify_chain) try config.roots.ensure(st.gpa, st.io, s.sslrootcert, diag);

    var entropy: [tls.Client.Options.entropy_len]u8 = undefined;
    st.io.random(&entropy);
    st.tls_client = tls.Client.init(&st.net_reader.interface, &st.net_writer.interface, .{
        .host = if (s.sslmode == .verify_full) .{ .explicit = s.host.? } else .no_verification,
        .ca = if (verify_chain) .{ .bundle = .{
            .gpa = st.gpa,
            .io = st.io,
            .lock = &config.roots.lock,
            .bundle = &config.roots.bundle,
        } } else .no_verification,
        .read_buffer = &st.tls_rbuf,
        .write_buffer = &st.tls_wbuf,
        .entropy = &entropy,
        .realtime_now = Io.Clock.real.now(st.io),
    }) catch |err| {
        diag.print("SSL connection to \"{s}\" failed: {s}", .{ s.host.?, tlsReason(err) });
        return if (verify_chain or required) error.ConnectFailed else error.TlsFailed;
    };
    st.use_tls = true;
}

fn tlsReason(err: anyerror) []const u8 {
    return switch (err) {
        error.TlsCertificateNotVerified => "certificate verify failed",
        error.CertificateHostMismatch => "server certificate does not match the host name",
        error.CertificateExpired => "server certificate has expired",
        error.CertificateIssuerNotFound => "server certificate is not signed by a trusted root",
        else => @errorName(err),
    };
}

fn startup(conn: Conn, s: *const Settings, diag: *Diagnostic) Error!void {
    const st = conn.state;
    var params: [8][2][]const u8 = undefined;
    var n: usize = 0;
    params[n] = .{ "user", s.user };
    n += 1;
    params[n] = .{ "database", s.dbname };
    n += 1;
    params[n] = .{ "application_name", s.application_name };
    n += 1;
    params[n] = .{ "client_encoding", "UTF8" };
    n += 1;
    if (s.options) |o| {
        params[n] = .{ "options", o };
        n += 1;
    }
    if (s.read_only) {
        params[n] = .{ "default_transaction_read_only", "on" };
        n += 1;
    }
    st.out.startup(st.gpa, params[0..n]) catch return error.OutOfMemory;
    st.send() catch return lost(st, diag);

    try authenticate(st, s, diag);

    while (true) {
        const msg = st.read() catch return lost(st, diag);
        switch (msg.tag) {
            'Z' => return,
            'E' => return serverError(diag, msg.body, null, error.ConnectFailed),
            'S', 'K', 'N' => {},
            else => return protocolError(st, diag, msg.tag),
        }
    }
}

fn authenticate(st: *State, s: *const Settings, diag: *Diagnostic) Error!void {
    var scram: ?auth.Scram = null;
    while (true) {
        const msg = st.read() catch return lost(st, diag);
        switch (msg.tag) {
            'E' => return serverError(diag, msg.body, null, error.ConnectFailed),
            'v', 'N' => continue,
            'R' => {},
            else => return protocolError(st, diag, msg.tag),
        }
        var c: wire.Cursor = .{ .body = msg.body };
        const code = c.int32() catch return protocolError(st, diag, 'R');
        switch (code) {
            0 => {
                if (s.channel_binding_required) {
                    diag.set("channel binding required, but server authenticated client without channel binding");
                    return error.ConnectFailed;
                }
                return;
            },
            3 => {
                const pw = try needPassword(s, diag);
                st.out.password(st.gpa, pw) catch return error.OutOfMemory;
            },
            5 => {
                const pw = try needPassword(s, diag);
                const salt = (c.take(4) catch return protocolError(st, diag, 'R'))[0..4].*;
                st.out.password(st.gpa, &auth.md5Password(s.user, pw, salt)) catch return error.OutOfMemory;
            },
            10 => {
                var has_scram = false;
                while (c.cstr()) |mech| {
                    if (mech.len == 0) break;
                    if (mem.eql(u8, mech, "SCRAM-SHA-256")) has_scram = true;
                } else |_| return protocolError(st, diag, 'R');
                if (!has_scram) {
                    diag.set("none of the server's SASL authentication mechanisms are supported");
                    return error.ConnectFailed;
                }
                if (s.channel_binding_required) {
                    diag.set("channel binding is required, but zetta does not support it yet");
                    return error.ConnectFailed;
                }
                _ = try needPassword(s, diag);
                var random: [18]u8 = undefined;
                st.io.random(&random);
                scram = .init(&random);
                var buf: [128]u8 = undefined;
                const first = scram.?.clientFirst("", &buf) catch return error.OutOfMemory;
                st.out.saslInitial(st.gpa, "SCRAM-SHA-256", first) catch return error.OutOfMemory;
            },
            11 => {
                var sc = &(scram orelse return protocolError(st, diag, 'R'));
                var buf: [512]u8 = undefined;
                const final = sc.clientFinal(c.rest(), s.password.?, &buf) catch {
                    diag.set("malformed SCRAM message from the server");
                    return error.ConnectFailed;
                };
                st.out.saslResponse(st.gpa, final) catch return error.OutOfMemory;
            },
            12 => {
                const sc = scram orelse return protocolError(st, diag, 'R');
                sc.verifyServerFinal(c.rest()) catch {
                    diag.set("incorrect server signature: the server could not prove it knows the password");
                    return error.ConnectFailed;
                };
                continue;
            },
            else => {
                diag.print("authentication method {d} requested by the server is not supported", .{code});
                return error.ConnectFailed;
            },
        }
        st.send() catch return lost(st, diag);
    }
}

fn needPassword(s: *const Settings, diag: *Diagnostic) Error![]const u8 {
    return s.password orelse {
        diag.set("password authentication failed: no password supplied");
        return error.ConnectFailed;
    };
}

fn lost(st: *State, diag: *Diagnostic) Error {
    st.broken = true;
    diag.set("server closed the connection unexpectedly");
    return error.ConnectFailed;
}

fn protocolError(st: *State, diag: *Diagnostic, tag: u8) Error {
    st.broken = true;
    diag.print("unexpected message type \"{c}\" from the server", .{tag});
    return error.ConnectFailed;
}

fn serverError(diag: *Diagnostic, body: []const u8, query: ?[]const u8, fallback: Error) Error {
    const notice = wire.Notice.parse(body);
    var w: std.Io.Writer = .fixed(&diag.buf);
    notice.format(query, &w) catch {};
    diag.len = std.mem.trimEnd(u8, w.buffered(), "\n").len;
    if (mem.eql(u8, notice.code, "25006")) return error.ReadOnly;
    // query_canceled: zetta never cancels, so this is statement_timeout firing.
    if (mem.eql(u8, notice.code, "57014")) return error.Timeout;
    return fallback;
}

pub fn close(self: *Conn) void {
    const st = self.state;
    if (!st.broken) {
        st.out.terminate(st.gpa) catch {};
        st.send() catch {};
        if (st.use_tls) {
            st.tls_client.end() catch {};
            st.net_writer.interface.flush() catch {};
        }
    }
    st.destroy();
}

pub fn healthy(self: *Conn) bool {
    return !self.state.broken;
}

/// A pooled connection must not carry one request's open transaction into the next.
pub fn inTransaction(self: *Conn) bool {
    return self.state.txn_status != 'I';
}

pub const Param = ?[]const u8;

/// Runs `text` with the simple protocol (several statements allowed, the last
/// result wins) or, with `params`, as one statement with the extended protocol.
pub fn run(self: *Conn, arena: Allocator, text: []const u8, params: ?[]const Param, max_rows: usize, diag: *Diagnostic) Error!types.ResultSet {
    const st = self.state;
    if (mem.indexOfScalar(u8, text, 0) != null) {
        diag.set("the query contains a NUL byte");
        return error.QueryFailed;
    }
    if (params) |p| {
        st.out.extendedQuery(st.gpa, text, p) catch return error.OutOfMemory;
    } else {
        st.out.query(st.gpa, text) catch return error.OutOfMemory;
    }
    st.send() catch return lost(st, diag);

    var last: types.ResultSet = .empty;
    var last_oids: []const u32 = &.{};
    var fields: ?[]wire.Field = null;
    var rows: std.ArrayList(types.Row) = .empty;
    var total: u64 = 0;
    var failure: ?Error = null;

    while (true) {
        const msg = st.read() catch return lost(st, diag);
        switch (msg.tag) {
            'T' => {
                fields = wire.rowDescription(arena, msg.body) catch return protocolError(st, diag, 'T');
                rows = .empty;
                total = 0;
            },
            'D' => {
                const f = fields orelse return protocolError(st, diag, 'D');
                total += 1;
                if (rows.items.len < max_rows) {
                    const cells = wire.dataRow(arena, msg.body, f.len) catch |err| switch (err) {
                        error.OutOfMemory => return error.OutOfMemory,
                        else => return protocolError(st, diag, 'D'),
                    };
                    try rows.append(arena, cells);
                }
            },
            'C' => {
                var c: wire.Cursor = .{ .body = msg.body };
                const tag = c.cstr() catch return protocolError(st, diag, 'C');
                const done = try finishResult(arena, fields, rows.items, total, tag);
                last = done.set;
                last_oids = done.oids;
                fields = null;
                rows = .empty;
                total = 0;
            },
            'I' => {
                last = .empty;
                last_oids = &.{};
            },
            'E' => failure = serverError(diag, msg.body, text, error.QueryFailed),
            'G' => {
                st.out.copyFail(st.gpa, "COPY FROM STDIN is not supported by zetta") catch return error.OutOfMemory;
                st.send() catch return lost(st, diag);
            },
            'H', 'd', 'c' => {},
            'W' => return protocolError(st, diag, 'W'),
            'S', 'N', 'A', 'K', '1', '2', '3', 'n', 't', 's' => {},
            'Z' => {
                st.txn_status = if (msg.body.len > 0) msg.body[0] else 'I';
                break;
            },
            else => return protocolError(st, diag, msg.tag),
        }
    }
    if (failure) |err| return err;

    for (@constCast(last.columns), last_oids) |*col, oid| {
        if (col.type_name.len == 0) col.type_name = try self.typeName(arena, oid, diag);
    }
    return last;
}

const Finished = struct { set: types.ResultSet, oids: []const u32 };

/// Built-in type names are filled in here; the rest wait for `typeName` once the server is idle.
fn finishResult(arena: Allocator, fields: ?[]wire.Field, rows: []const types.Row, total: u64, tag: []const u8) Allocator.Error!Finished {
    const command = try arena.dupe(u8, tag);
    const f = fields orelse return .{ .set = .{
        .columns = &.{},
        .rows = &.{},
        .row_count = wire.tagRows(tag),
        .truncated = false,
        .command = command,
    }, .oids = &.{} };
    const cols = try arena.alloc(types.ResultColumn, f.len);
    const oids = try arena.alloc(u32, f.len);
    for (cols, oids, f) |*col, *oid, field| {
        col.* = .{ .name = field.name, .type_name = sql.builtinTypeName(field.type_oid) orelse "" };
        oid.* = field.type_oid;
    }
    return .{ .set = .{
        .columns = cols,
        .rows = rows,
        .row_count = total,
        .truncated = total > rows.len,
        .command = command,
    }, .oids = oids };
}

/// Limits each statement that follows to `ms`, or with null puts back the session's default.
pub fn statementTimeout(self: *Conn, arena: Allocator, ms: ?u32, diag: *Diagnostic) Error!void {
    const st = self.state;
    const want: StatementTimeout = if (ms) |v| .{ .ms = v } else .default;
    if (std.meta.eql(st.statement_timeout, want)) return;
    const text = if (ms) |v| try std.fmt.allocPrint(arena, "set statement_timeout = {d}", .{v}) else "reset statement_timeout";
    _ = try self.run(arena, text, null, 0, diag);
    st.statement_timeout = want;
}

/// Records that caller SQL ran, which may have changed statement_timeout behind zetta's back.
pub fn callerSqlRan(self: *Conn) void {
    if (self.state.statement_timeout != .default) self.state.statement_timeout = .unsure;
}

/// Names for types outside the built-in table (enums, domains, extensions), cached per connection.
fn typeName(self: *Conn, arena: Allocator, oid: u32, diag: *Diagnostic) Error![]const u8 {
    const st = self.state;
    // Results only point into the caller's arena, never at connection memory.
    if (st.type_names.get(oid)) |name| return arena.dupe(u8, name);
    var oid_buf: [16]u8 = undefined;
    const oid_text = std.fmt.bufPrint(&oid_buf, "{d}", .{oid}) catch unreachable;
    const res = try self.run(arena, sql.type_name_lookup, &.{oid_text}, 1, diag);
    const name = if (res.rows.len == 1) res.rows[0][0] orelse "unknown" else "unknown";
    const owned = try st.gpa.dupe(u8, name);
    st.type_names.put(st.gpa, oid, owned) catch {
        st.gpa.free(owned);
        return error.OutOfMemory;
    };
    return arena.dupe(u8, owned);
}
