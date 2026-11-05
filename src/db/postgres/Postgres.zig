//! Postgres over the native wire protocol, behind a small connection pool.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Adapter = @import("../Adapter.zig");
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Pool = @import("../pool.zig").Pool;
const Conn = @import("Conn.zig");
const conninfo = @import("conninfo.zig");
const settings_mod = @import("settings.zig");
const sql = @import("sql.zig");
const builder = @import("../builder.zig");
const dialect = @import("dialect.zig").dialect;

const Postgres = @This();

gpa: Allocator,
arena_state: std.heap.ArenaAllocator,
settings: settings_mod.Settings,
roots: Conn.Roots = .{},
pool: Pool(PooledConn),
read_only: bool,

/// The pool hands out values; a Conn is already a pointer to its heap state.
const PooledConn = struct {
    conn: Conn,

    pub const Config = Conn.Config;

    pub fn connect(config: Config, diag: *Diagnostic) types.Error!PooledConn {
        return .{ .conn = try Conn.connect(config, diag) };
    }

    pub fn close(self: *PooledConn) void {
        self.conn.close();
    }

    pub fn healthy(self: *PooledConn) bool {
        return self.conn.healthy();
    }
};

/// Connects once up front so a bad DSN fails at startup, not on first use.
pub fn open(gpa: Allocator, io: Io, text: []const u8, options: types.OpenOptions, diag: *Diagnostic) types.Error!*Postgres {
    const self = try gpa.create(Postgres);
    errdefer gpa.destroy(self);
    self.* = .{
        .gpa = gpa,
        .arena_state = .init(gpa),
        .settings = undefined,
        .pool = undefined,
        .read_only = options.read_only,
    };
    errdefer self.arena_state.deinit();
    const arena = self.arena_state.allocator();

    var parse_err: conninfo.ErrorText = .{};
    const cfg = conninfo.parse(arena, text, &parse_err) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidConnInfo => {
            diag.set(parse_err.message());
            return error.ConnectFailed;
        },
    };
    self.settings = settings_mod.resolve(arena, io, cfg, options.env, options.read_only, diag) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidSettings => return error.ConnectFailed,
    };

    self.pool = try .init(gpa, io, .{ .gpa = gpa, .io = io, .settings = &self.settings, .roots = &self.roots }, @max(options.pool_size, 1));
    errdefer self.pool.deinit(gpa);
    errdefer self.roots.deinit(gpa);

    const lease = try self.pool.acquire(diag);
    lease.release();
    return self;
}

pub fn adapter(self: *Postgres) Adapter {
    return .{ .ptr = self, .vtable = &vtable };
}

const vtable: Adapter.VTable = .{
    .info = info,
    .catalog = catalog,
    .columns = columns,
    .detail = detail,
    .count = count,
    .browse = browse,
    .query = query,
    .deinit = deinit,
};

fn from(ptr: *anyopaque) *Postgres {
    return @ptrCast(@alignCast(ptr));
}

fn deinit(ptr: *anyopaque) void {
    const self = from(ptr);
    const gpa = self.gpa;
    self.pool.deinit(gpa);
    self.roots.deinit(gpa);
    self.arena_state.deinit();
    gpa.destroy(self);
}

fn info(ptr: *anyopaque) Adapter.Info {
    const self = from(ptr);
    return .{
        .name = .postgres,
        .database = self.settings.dbname,
        .read_only = self.read_only,
        .capabilities = .{ .schemas = true, .approx_rows = true },
        .dialect = &dialect,
    };
}

fn run(self: *Postgres, arena: Allocator, text: []const u8, params: ?[]const Conn.Param, max_rows: usize, diag: *Diagnostic) types.Error!types.ResultSet {
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = &lease.conn.conn;
    defer endTransaction(conn, arena);
    return conn.run(arena, text, params, max_rows, diag);
}

/// How `runBudgeted` sends the text.
const How = union(enum) {
    /// As `Conn.runLimited`.
    params: ?[]const Conn.Param,
    /// As `Conn.query`.
    query: struct { one_statement: bool },
};

/// Browse and query: applies their budget and limits, then ends the request as `endRequest` does.
fn runBudgeted(self: *Postgres, arena: Allocator, text: []const u8, how: How, limits: types.Limits, budget_ms: ?u32, caller_sql: bool, diag: *Diagnostic) types.Error!types.ResultSet {
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = &lease.conn.conn;
    defer self.endRequest(conn, arena, caller_sql);
    try conn.statementTimeout(arena, budget_ms, diag);
    const res = switch (how) {
        .params => |p| conn.runLimited(arena, text, p, limits, diag),
        .query => |q| conn.query(arena, text, limits, q.one_statement, diag),
    };
    return res catch |err| {
        if (err == error.Timeout) if (budget_ms) |ms| diag.print("the statement ran past its {d} ms budget", .{ms});
        return err;
    };
}

/// Caller SQL can hold any statement. After it zetta stops trusting the statement_timeout it
/// set, and in read-only mode resets the session, since a SET or set_config() would otherwise
/// leave default_transaction_read_only off for whoever uses the connection next.
fn endRequest(self: *Postgres, conn: *Conn, arena: Allocator, caller_sql: bool) void {
    endTransaction(conn, arena);
    if (!caller_sql) return;
    if (self.read_only) conn.resetSession(arena) else conn.callerSqlRan();
}

/// Each request stands alone: a BEGIN without COMMIT would otherwise hold its
/// locks on a pooled connection and leak into whoever uses it next.
fn endTransaction(conn: *Conn, arena: Allocator) void {
    if (!conn.healthy() or !conn.inTransaction()) return;
    var scratch: Diagnostic = .{};
    // A failed rollback leaves the connection broken, and the pool replaces broken ones.
    _ = conn.run(arena, "rollback", null, 0, &scratch) catch {};
}

fn count(ptr: *anyopaque, arena: Allocator, req: types.CountRequest, diag: *Diagnostic) types.Error!u64 {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = &lease.conn.conn;
    defer self.endRequest(conn, arena, nonEmpty(req.filter));

    // statement_timeout = 0 would mean no limit at all.
    const budget = @max(req.budget_ms, 1);
    _ = try conn.run(arena, "begin", null, 0, diag);
    _ = try conn.run(arena, try std.fmt.allocPrint(arena, "set local statement_timeout = {d}", .{budget}), null, 0, diag);

    const exists = try conn.run(arena, sql.relation_exists, &.{ req.table.schema, req.table.table }, 1, diag);
    if (exists.rows.len == 0) {
        diag.print("no table named {s}.{s}", .{ req.table.schema, req.table.table });
        return error.NotFound;
    }

    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    const compiled = if (req.builder) |b| try builder.compile(arena, b, &dialect, .bind) else builder.Compiled.empty;
    w.print("select count(*) from {s}.{s}", .{ try quoteIdent(arena, req.table.schema), try quoteIdent(arena, req.table.table) }) catch return error.OutOfMemory;
    builder.writeWhere(w, req.filter, compiled.where) catch return error.OutOfMemory;
    // The extended protocol takes exactly one statement, so the filter cannot smuggle in another.
    const res = conn.run(arena, text.written(), try bindParams(arena, compiled.params), 1, diag) catch |err| {
        if (err == error.Timeout) diag.print("counting took longer than the {d} ms budget", .{budget});
        return err;
    };
    _ = try conn.run(arena, "commit", null, 0, diag);

    const cell = if (res.rows.len == 1) res.rows[0][0] else null;
    return std.fmt.parseInt(u64, cell orelse "", 10) catch {
        diag.print("count(*) returned {s}", .{cell orelse "nothing"});
        return error.QueryFailed;
    };
}

fn catalog(ptr: *anyopaque, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    const self = from(ptr);
    const res = try self.run(arena, sql.catalog, null, std.math.maxInt(usize), diag);

    var schemas: std.ArrayList(types.Schema) = .empty;
    var tables: std.ArrayList(types.Table) = .empty;
    var current: ?[]const u8 = null;
    for (res.rows) |row| {
        const schema = row[0].?;
        if (current == null or !std.mem.eql(u8, current.?, schema)) {
            if (current) |name| try schemas.append(arena, .{ .name = name, .tables = try tables.toOwnedSlice(arena) });
            current = schema;
        }
        const name = row[1] orelse continue;
        try tables.append(arena, .{
            .name = name,
            .kind = tableKind(row[2].?),
            .approx_rows = if (row[3]) |v| std.fmt.parseInt(u64, v, 10) catch null else null,
        });
    }
    if (current) |name| try schemas.append(arena, .{ .name = name, .tables = try tables.toOwnedSlice(arena) });
    return .{ .schemas = try schemas.toOwnedSlice(arena) };
}

fn tableKind(relkind: []const u8) types.TableKind {
    return switch (relkind[0]) {
        'v' => .view,
        'm' => .materialized_view,
        'f' => .foreign_table,
        else => .table,
    };
}

fn columns(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error![]const types.Column {
    const self = from(ptr);
    const res = try self.run(arena, sql.columns, &.{ table.schema, table.table }, std.math.maxInt(usize), diag);
    if (res.rows.len == 0) {
        diag.print("no table named {s}.{s}", .{ table.schema, table.table });
        return error.NotFound;
    }
    return columnsFrom(arena, res);
}

fn columnsFrom(arena: Allocator, res: types.ResultSet) Allocator.Error![]types.Column {
    const out = try arena.alloc(types.Column, res.rows.len);
    for (out, res.rows) |*col, row| {
        col.* = .{
            .name = row[0].?,
            .type_name = row[1].?,
            .nullable = isTrue(row[2]),
            .primary_key = isTrue(row[3]),
            .default = row[4],
            .comment = row[5],
        };
    }
    return out;
}

fn detail(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error!types.TableDetail {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = &lease.conn.conn;
    const params: []const Conn.Param = &.{ table.schema, table.table };
    const all = std.math.maxInt(usize);

    // Catalog reads never open a transaction, so the lease needs no rollback guard.
    const head_res = try conn.run(arena, sql.detail_table, params, all, diag);
    if (head_res.rows.len == 0) {
        diag.print("no table named {s}.{s}", .{ table.schema, table.table });
        return error.NotFound;
    }
    const head = head_res.rows[0];
    const kind = tableKind(head[2].?);

    const col_res = try conn.run(arena, sql.columns, params, all, diag);
    const cols = try columnsFrom(arena, col_res);

    const con_res = try conn.run(arena, sql.detail_constraints, params, all, diag);
    const constraints = try arena.alloc(types.Constraint, con_res.rows.len);
    for (constraints, con_res.rows) |*con, row| {
        con.* = .{
            .name = row[0].?,
            .kind = constraintKind(row[1].?),
            .definition = row[2].?,
            .columns = try nameList(arena, row[3], diag),
        };
    }

    const fk_res = try conn.run(arena, sql.detail_foreign_keys, params, all, diag);
    const fks = try arena.alloc(types.ForeignKey, fk_res.rows.len);
    for (fks, fk_res.rows) |*fk, row| {
        fk.* = .{
            .name = row[0].?,
            .ref_schema = row[1].?,
            .ref_table = row[2].?,
            .columns = try nameList(arena, row[3], diag),
            .ref_columns = try nameList(arena, row[4], diag),
            .on_update = fkAction(row[5].?),
            .on_delete = fkAction(row[6].?),
        };
    }

    const ref_res = try conn.run(arena, sql.detail_referenced_by, params, all, diag);
    const refs = try arena.alloc(types.Reference, ref_res.rows.len);
    for (refs, ref_res.rows) |*ref, row| {
        ref.* = .{
            .name = row[0].?,
            .schema = row[1].?,
            .table = row[2].?,
            .columns = try nameList(arena, row[3], diag),
            .ref_columns = try nameList(arena, row[4], diag),
            .on_update = fkAction(row[5].?),
            .on_delete = fkAction(row[6].?),
        };
    }

    const idx_res = try conn.run(arena, sql.detail_indexes, params, all, diag);
    const indexes = try arena.alloc(types.Index, idx_res.rows.len);
    for (indexes, idx_res.rows) |*idx, row| {
        idx.* = .{
            .name = row[0].?,
            .unique = isTrue(row[1]),
            .primary = isTrue(row[2]),
            .method = row[3].?,
            .predicate = row[4],
            .definition = row[5],
            .size_bytes = parseCount(row[6]),
            .scans = parseCount(row[7]),
            .columns = try nameList(arena, row[8], diag),
        };
    }

    const trg_res = try conn.run(arena, sql.detail_triggers, params, all, diag);
    const triggers = try arena.alloc(types.Trigger, trg_res.rows.len);
    for (triggers, trg_res.rows) |*trg, row| {
        const tgtype = std.fmt.parseInt(u16, row[1].?, 10) catch {
            diag.print("unreadable tgtype {s} on trigger {s}", .{ row[1].?, row[0].? });
            return error.QueryFailed;
        };
        trg.* = .{
            .name = row[0].?,
            .timing = if (tgtype & 2 != 0) .before else if (tgtype & 64 != 0) .instead_of else .after,
            .events = try triggerEvents(arena, tgtype),
            .level = if (tgtype & 1 != 0) .row else .statement,
            .function = row[2],
            .definition = row[3].?,
            .enabled = isTrue(row[4]),
        };
    }

    const sizes: ?types.Sizes = if (parseCount(head[4])) |total| .{
        .total = total,
        .table = parseCount(head[5]) orelse 0,
        .indexes = parseCount(head[6]) orelse 0,
    } else null;

    return .{
        .schema = head[0].?,
        .name = head[1].?,
        .kind = kind,
        .approx_rows = parseCount(head[3]),
        .size_bytes = sizes,
        .comment = head[7],
        .columns = cols,
        .constraints = constraints,
        .indexes = indexes,
        .foreign_keys = fks,
        .referenced_by = refs,
        .triggers = triggers,
        .ddl = try ddl(arena, .{
            .relkind = head[2].?[0],
            .qualified = head[9].?,
            .view_def = head[8],
            .partition_key = head[10],
            .comment = head[7],
            .columns = col_res.rows,
            .constraints = con_res.rows,
            .indexes = idx_res.rows,
            .triggers = triggers,
        }),
    };
}

/// Counts and sizes are bigint or null; anything unparseable is reported as unknown.
fn parseCount(v: ?[]const u8) ?u64 {
    return if (v) |s| std.fmt.parseInt(u64, s, 10) catch null else null;
}

/// Name lists arrive as `json_agg(...)::text`.
fn nameList(arena: Allocator, text: ?[]const u8, diag: *Diagnostic) types.Error![]const []const u8 {
    const t = text orelse return &.{};
    return std.json.parseFromSliceLeaky([]const []const u8, arena, t, .{}) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => {
            diag.print("unreadable name list from the catalog ({s}): {s}", .{ @errorName(err), t });
            return error.QueryFailed;
        },
    };
}

fn constraintKind(contype: []const u8) types.ConstraintKind {
    return switch (contype[0]) {
        'p' => .primary_key,
        'u' => .unique,
        'f' => .foreign_key,
        'x' => .exclusion,
        else => .check,
    };
}

fn fkAction(code: []const u8) types.FkAction {
    return switch (code[0]) {
        'r' => .restrict,
        'c' => .cascade,
        'n' => .set_null,
        'd' => .set_default,
        else => .no_action,
    };
}

/// Decodes the event bits of `pg_trigger.tgtype`.
fn triggerEvents(arena: Allocator, tgtype: u16) Allocator.Error![]const types.TriggerEvent {
    const bits = [_]struct { u16, types.TriggerEvent }{ .{ 4, .insert }, .{ 16, .update }, .{ 8, .delete }, .{ 32, .truncate } };
    var out: std.ArrayList(types.TriggerEvent) = .empty;
    for (bits) |b| if (tgtype & b[0] != 0) try out.append(arena, b[1]);
    return out.items;
}

const DdlInput = struct {
    relkind: u8,
    /// `schema.name`, quoted where Postgres needs it.
    qualified: []const u8,
    view_def: ?[]const u8,
    partition_key: ?[]const u8,
    comment: ?[]const u8,
    /// Rows of `sql.columns`, `sql.detail_constraints` and `sql.detail_indexes`.
    columns: []const types.Row,
    constraints: []const types.Row,
    indexes: []const types.Row,
    triggers: []const types.Trigger,
};

/// Rebuilds the creating statements from the catalog, the way the contract in docs/API.md describes.
fn ddl(arena: Allocator, in: DdlInput) Allocator.Error![]const u8 {
    var out: std.Io.Writer.Allocating = .init(arena);
    writeDdl(&out.writer, in) catch return error.OutOfMemory;
    return out.written();
}

fn writeDdl(w: *std.Io.Writer, in: DdlInput) std.Io.Writer.Error!void {
    switch (in.relkind) {
        'v', 'm' => {
            const def = std.mem.trim(u8, in.view_def orelse "", " \t\r\n;");
            try w.print("CREATE {s}VIEW {s} AS\n{s};", .{ if (in.relkind == 'm') "MATERIALIZED " else "", in.qualified, def });
        },
        else => {
            try w.print("CREATE {s}TABLE {s} (", .{ if (in.relkind == 'f') "FOREIGN " else "", in.qualified });
            var first = true;
            for (in.columns) |row| {
                try w.writeAll(if (first) "\n  " else ",\n  ");
                first = false;
                try w.print("{s} {s}", .{ row[6].?, row[1].? });
                const identity = row[7] orelse "";
                const generated = row[8] orelse "";
                if (generated.len > 0 and row[4] != null) {
                    try w.print(" GENERATED ALWAYS AS ({s}) {s}", .{ row[4].?, if (generated[0] == 'v') "VIRTUAL" else "STORED" });
                } else if (identity.len > 0) {
                    try w.print(" GENERATED {s} AS IDENTITY", .{if (identity[0] == 'a') "ALWAYS" else "BY DEFAULT"});
                } else if (row[4]) |default| {
                    try w.print(" DEFAULT {s}", .{default});
                }
                if (!isTrue(row[2])) try w.writeAll(" NOT NULL");
            }
            for (in.constraints) |row| {
                try w.writeAll(if (first) "\n  " else ",\n  ");
                first = false;
                try w.print("CONSTRAINT {s} {s}", .{ row[4].?, row[2].? });
            }
            try w.writeAll("\n)");
            if (in.partition_key) |key| try w.print(" PARTITION BY {s}", .{key});
            try w.writeAll(";");
        },
    }

    var gap = true;
    for (in.indexes) |row| {
        if (isTrue(row[9])) continue;
        try w.writeAll(if (gap) "\n\n" else "\n");
        gap = false;
        try w.print("{s};", .{row[5].?});
    }
    gap = true;
    for (in.triggers) |t| {
        try w.writeAll(if (gap) "\n\n" else "\n");
        gap = false;
        try w.print("{s};", .{t.definition});
    }

    gap = true;
    const object = switch (in.relkind) {
        'v' => "VIEW",
        'm' => "MATERIALIZED VIEW",
        'f' => "FOREIGN TABLE",
        else => "TABLE",
    };
    if (in.comment) |text| {
        try w.print("\n\nCOMMENT ON {s} {s} IS ", .{ object, in.qualified });
        try writeLiteral(w, text);
        try w.writeAll(";");
        gap = false;
    }
    for (in.columns) |row| {
        const text = row[5] orelse continue;
        try w.writeAll(if (gap) "\n\n" else "\n");
        gap = false;
        try w.print("COMMENT ON COLUMN {s}.{s} IS ", .{ in.qualified, row[6].? });
        try writeLiteral(w, text);
        try w.writeAll(";");
    }
}

/// A standard-conforming string literal: quotes doubled, backslashes left alone.
fn writeLiteral(w: *std.Io.Writer, text: []const u8) std.Io.Writer.Error!void {
    try w.writeByte('\'');
    for (text) |ch| {
        if (ch == '\'') try w.writeByte('\'');
        try w.writeByte(ch);
    }
    try w.writeByte('\'');
}

/// `name` becomes `"name"`, with embedded quotes doubled, as PQescapeIdentifier does.
pub fn quoteIdent(arena: Allocator, ident: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.ensureTotalCapacity(arena, ident.len + 2);
    out.appendAssumeCapacity('"');
    for (ident) |ch| {
        if (ch == '"') try out.append(arena, '"');
        try out.append(arena, ch);
    }
    try out.append(arena, '"');
    return out.items;
}

fn browse(ptr: *anyopaque, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    const compiled = if (req.builder) |b| try builder.compile(arena, b, &dialect, .bind) else builder.Compiled.empty;
    w.print("select * from {s}.{s}", .{ try quoteIdent(arena, req.table.schema), try quoteIdent(arena, req.table.table) }) catch return error.OutOfMemory;
    builder.writeWhere(w, req.filter, compiled.where) catch return error.OutOfMemory;
    builder.writeOrder(w, req.order, compiled.order) catch return error.OutOfMemory;
    w.print(" limit {d} offset {d}", .{ req.limit, req.offset }) catch return error.OutOfMemory;
    const caller_sql = nonEmpty(req.filter) or nonEmpty(req.order);
    // With a builder the statement goes through the extended protocol, which binds the values.
    // In read-only mode a raw filter goes that way too, so it cannot hold a second statement.
    const params: ?[]const Conn.Param = if (req.builder != null)
        try bindParams(arena, compiled.params)
    else if (self.read_only and caller_sql) &.{} else null;
    const limits: types.Limits = .{ .max_rows = req.limit, .max_bytes = req.max_bytes };
    return self.runBudgeted(arena, text.written(), .{ .params = params }, limits, req.budget_ms, caller_sql, diag);
}

fn nonEmpty(s: ?[]const u8) bool {
    return if (s) |text| text.len > 0 else false;
}

/// Builder values as untyped text parameters, so Postgres infers each from its column.
fn bindParams(arena: Allocator, values: []const []const u8) Allocator.Error![]const Conn.Param {
    const out = try arena.alloc(Conn.Param, values.len);
    for (out, values) |*p, v| p.* = v;
    return out;
}

fn query(ptr: *anyopaque, arena: Allocator, text: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    if (self.read_only and controlsTransactions(text)) {
        diag.set("read-only mode refuses DO and CALL, which can commit and go on writing");
        return error.ReadOnly;
    }
    const how: How = .{ .query = .{ .one_statement = self.read_only } };
    return self.runBudgeted(arena, text, how, options.limits(), options.budget_ms, true, diag);
}

/// DO and CALL can COMMIT and carry on in a new transaction, which reads
/// default_transaction_read_only again after the statement may have turned it off.
fn controlsTransactions(text: []const u8) bool {
    const word = leadingWord(text);
    return std.ascii.eqlIgnoreCase(word, "do") or std.ascii.eqlIgnoreCase(word, "call");
}

/// The first word, past whitespace, empty statements and comments, which nest in Postgres.
fn leadingWord(text: []const u8) []const u8 {
    var i: usize = 0;
    while (i < text.len) {
        if (std.ascii.isWhitespace(text[i]) or text[i] == ';') {
            i += 1;
        } else if (std.mem.startsWith(u8, text[i..], "--")) {
            i = std.mem.indexOfScalarPos(u8, text, i, '\n') orelse text.len;
        } else if (std.mem.startsWith(u8, text[i..], "/*")) {
            var depth: usize = 0;
            while (i < text.len) {
                if (std.mem.startsWith(u8, text[i..], "/*")) {
                    depth += 1;
                    i += 2;
                } else if (std.mem.startsWith(u8, text[i..], "*/")) {
                    depth -= 1;
                    i += 2;
                    if (depth == 0) break;
                } else i += 1;
            }
        } else break;
    }
    var end = i;
    while (end < text.len and (std.ascii.isAlphanumeric(text[end]) or text[end] == '_' or text[end] == '$')) end += 1;
    return text[i..end];
}

fn isTrue(v: ?[]const u8) bool {
    return if (v) |s| s.len > 0 and s[0] == 't' else false;
}

test "trigger type bits decode into events in a fixed order" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    // ROW | BEFORE | INSERT | UPDATE
    const events = try triggerEvents(arena_state.allocator(), 1 | 2 | 4 | 16);
    try std.testing.expectEqualSlices(types.TriggerEvent, &.{ .insert, .update }, events);
}

test "comment literals double their quotes" {
    var buf: [32]u8 = undefined;
    var w: std.Io.Writer = .fixed(&buf);
    try writeLiteral(&w, "it's");
    try std.testing.expectEqualStrings("'it''s'", w.buffered());
}

test "identifiers are quoted with embedded quotes doubled" {
    var arena_state: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena_state.deinit();
    try std.testing.expectEqualStrings("\"we\"\"ird\"", try quoteIdent(arena_state.allocator(), "we\"ird"));
}

test "DO and CALL are found past comments and empty statements" {
    try std.testing.expect(controlsTransactions("do $$ begin commit; end $$"));
    try std.testing.expect(controlsTransactions("  ;\n-- note\n/* a /* nested */ comment */ CALL p()"));
    try std.testing.expect(!controlsTransactions("select 'do'"));
    try std.testing.expect(!controlsTransactions("do_things()"));
    try std.testing.expect(!controlsTransactions("-- do"));
    try std.testing.expect(!controlsTransactions(""));
}
