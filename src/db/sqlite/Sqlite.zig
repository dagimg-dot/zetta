//! SQLite from the vendored amalgamation. Schemas are attached databases.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Adapter = @import("../Adapter.zig");
const Diagnostic = @import("../Diagnostic.zig");
const types = @import("../types.zig");
const Pool = @import("../pool.zig").Pool;
const Conn = @import("Conn.zig");
const parse = @import("parse.zig");
const builder = @import("../builder.zig");
const dialect = @import("dialect.zig").dialect;

const Sqlite = @This();

gpa: Allocator,
io: Io,
path: [:0]u8,
pool: Pool(Conn),
database: []const u8,
read_only: bool,

const schemas_sql = "select name from pragma_database_list order by seq";
const columns_sql =
    \\select name, type, "notnull", pk, dflt_value from pragma_table_info(?1, ?2)
;

pub const Target = struct {
    path: []const u8,
    uri: bool,
};

/// Opens one connection up front so a missing file fails at startup.
pub fn open(gpa: Allocator, io: Io, target: Target, options: types.OpenOptions, diag: *Diagnostic) types.Error!*Sqlite {
    const self = try gpa.create(Sqlite);
    errdefer gpa.destroy(self);
    const owned = try gpa.dupeZ(u8, target.path);
    errdefer gpa.free(owned);
    const config: Conn.Config = .{ .path = owned, .uri = target.uri, .read_only = options.read_only };
    // Each connection to ":memory:" would be its own empty database.
    const size = if (std.mem.eql(u8, owned, ":memory:")) 1 else @max(options.pool_size, 1);

    self.* = .{
        .gpa = gpa,
        .io = io,
        .path = owned,
        .pool = try .init(gpa, io, config, size),
        .database = displayName(owned, target.uri),
        .read_only = options.read_only,
    };
    errdefer self.pool.deinit(gpa);
    const lease = try self.pool.acquire(diag);
    lease.release();
    return self;
}

fn displayName(path: []const u8, uri: bool) []const u8 {
    var name = path;
    if (uri) {
        name = name["file:".len..];
        if (std.mem.indexOfScalar(u8, name, '?')) |q| name = name[0..q];
    }
    return std.fs.path.basename(name);
}

pub fn adapter(self: *Sqlite) Adapter {
    return .{ .ptr = self, .vtable = &vtable };
}

const vtable: Adapter.VTable = .{
    .info = info,
    .catalog = catalog,
    .columns = columns,
    .detail = detail,
    .function = function,
    .count = count,
    .browse = browse,
    .query = query,
    .deinit = deinit,
};

fn from(ptr: *anyopaque) *Sqlite {
    return @ptrCast(@alignCast(ptr));
}

fn deinit(ptr: *anyopaque) void {
    const self = from(ptr);
    const gpa = self.gpa;
    self.pool.deinit(gpa);
    gpa.free(self.path);
    gpa.destroy(self);
}

fn info(ptr: *anyopaque) Adapter.Info {
    const self = from(ptr);
    return .{
        .name = .sqlite,
        .database = self.database,
        .read_only = self.read_only,
        .capabilities = .{ .schemas = true, .approx_rows = false },
        .dialect = &dialect,
    };
}

fn catalog(ptr: *anyopaque, arena: Allocator, diag: *Diagnostic) types.Error!types.Catalog {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    const names = try lease.conn.runAll(arena, schemas_sql, .{}, diag);
    const schemas = try arena.alloc(types.Schema, names.rows.len);
    for (schemas, names.rows) |*schema, row| {
        const name = row[0].?;
        const text = try std.fmt.allocPrint(arena,
            \\select name, type from {s}.sqlite_schema
            \\where type in ('table', 'view') and name not like 'sqlite\_%' escape '\'
            \\order by name
        , .{try Conn.quoteIdent(arena, name)});
        const res = try lease.conn.runAll(arena, text, .{}, diag);
        const tables = try arena.alloc(types.Table, res.rows.len);
        for (tables, res.rows) |*table, t| {
            table.* = .{
                .name = t[0].?,
                .kind = if (std.mem.eql(u8, t[1].?, "view")) .view else .table,
                .approx_rows = null,
            };
        }
        schema.* = .{ .name = name, .tables = tables };
    }
    return .{ .schemas = schemas };
}

fn columns(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error![]const types.Column {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();

    const res = try lease.conn.runBound(arena, columns_sql, &.{ table.table, table.schema }, diag);
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
            .type_name = try std.ascii.allocLowerString(arena, row[1] orelse ""),
            .nullable = std.mem.eql(u8, row[2].?, "0"),
            .primary_key = !std.mem.eql(u8, row[3].?, "0"),
            .default = row[4],
        };
    }
    return out;
}

/// SQL cannot define a function in SQLite; the only ones are built in or registered from C.
fn function(_: *anyopaque, _: Allocator, ref: types.FunctionRef, diag: *Diagnostic) types.Error!types.FunctionDetail {
    diag.print("no function named {s}.{s}: SQLite does not store functions", .{ ref.schema, ref.name });
    return error.NotFound;
}

fn notFound(table: types.TableRef, diag: *Diagnostic) types.Error {
    diag.print("no table named {s}.{s}", .{ table.schema, table.table });
    return error.NotFound;
}

/// `fmt` with the quoted schema spliced in once.
fn withSchema(arena: Allocator, comptime fmt: []const u8, quoted_schema: []const u8) Allocator.Error![:0]const u8 {
    return std.fmt.allocPrintSentinel(arena, fmt, .{quoted_schema}, 0);
}

/// A table or view by its stored names, or NotFound.
const Found = struct {
    schema: []const u8,
    /// `schema`, quoted.
    q: []const u8,
    name: []const u8,
    kind: types.TableKind,
    sql: ?[]const u8,
};

fn lookup(conn: *Conn, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error!Found {
    // An unknown schema would make `schema.sqlite_schema` an error instead of an empty result.
    const known = try conn.runBound(arena, "select name from pragma_database_list where name = ?1 collate nocase", &.{table.schema}, diag);
    if (known.rows.len == 0) return notFound(table, diag);
    const schema = known.rows[0][0].?;
    const q = try Conn.quoteIdent(arena, schema);

    const head = try conn.runBound(arena, try withSchema(arena,
        \\select name, type, sql from {s}.sqlite_schema
        \\where type in ('table', 'view') and name = ?1 collate nocase
    , q), &.{table.table}, diag);
    if (head.rows.len == 0) return notFound(table, diag);
    return .{
        .schema = schema,
        .q = q,
        .name = head.rows[0][0].?,
        .kind = if (std.mem.eql(u8, head.rows[0][1].?, "view")) .view else .table,
        .sql = head.rows[0][2],
    };
}

fn count(ptr: *anyopaque, arena: Allocator, req: types.CountRequest, diag: *Diagnostic) types.Error!u64 {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = lease.conn;
    const found = try lookup(conn, arena, req.table, diag);

    const compiled = if (req.builder) |b| try builder.compile(arena, b, &dialect, .bind) else builder.Compiled.empty;
    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    w.print("select count(*) from {s}.{s}", .{ found.q, try Conn.quoteIdent(arena, found.name) }) catch return error.OutOfMemory;
    builder.writeWhere(w, req.filter, compiled.where) catch return error.OutOfMemory;
    w.writeByte(0) catch return error.OutOfMemory;
    const z = text.written();
    const dqs = if (req.builder != null) conn.strictIdentifiers() else null;
    defer if (dqs) |was| conn.restoreDoubleQuotedStrings(was);
    const deadline: Conn.Deadline = .after(self.io, req.budget_ms);
    const res = conn.runBoundUntil(arena, z[0 .. z.len - 1 :0], compiled.params, &deadline, diag) catch |err| {
        if (err == error.Timeout) diag.print("counting took longer than the {d} ms budget", .{req.budget_ms});
        return err;
    };
    const cell = if (res.rows.len == 1) res.rows[0][0] else null;
    return std.fmt.parseInt(u64, cell orelse "", 10) catch {
        diag.print("count(*) returned {s}", .{cell orelse "nothing"});
        return error.QueryFailed;
    };
}

fn detail(ptr: *anyopaque, arena: Allocator, table: types.TableRef, diag: *Diagnostic) types.Error!types.TableDetail {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    const conn = lease.conn;

    const found = try lookup(conn, arena, table, diag);
    const schema = found.schema;
    const q = found.q;
    const name = found.name;
    const kind = found.kind;

    const col_res = try conn.runBound(arena, columns_sql, &.{ name, schema }, diag);
    const cols = try columnsFrom(arena, col_res);
    const pk = try primaryKey(arena, col_res);

    const indexes = try readIndexes(conn, arena, name, schema, q, diag);
    const fks = try readForeignKeys(conn, arena, name, schema, diag);
    const refs = try readReferences(conn, arena, name, schema, q, pk, diag);
    const trig_res = try conn.runBound(arena, try withSchema(arena,
        \\select name, sql from {s}.sqlite_schema
        \\where type = 'trigger' and tbl_name = ?1 collate nocase order by name
    , q), &.{name}, diag);
    const triggers = try arena.alloc(types.Trigger, trig_res.rows.len);
    for (triggers, trig_res.rows) |*t, row| {
        const sql = row[1] orelse "";
        // SQLite parsed this text when it stored it, so a miss means a form the parser
        // does not know yet; the trigger is still listed with its definition.
        const h = parse.triggerHead(sql);
        t.* = .{
            .name = row[0].?,
            .timing = if (h) |x| x.timing else .before,
            .events = if (h) |x| try arena.dupe(types.TriggerEvent, &.{x.event}) else &.{},
            .level = .row,
            .function = null,
            .definition = sql,
            .enabled = true,
        };
    }

    var ddl: std.ArrayList(u8) = .empty;
    try ddl.appendSlice(arena, found.sql orelse "");
    try ddl.append(arena, ';');
    for (indexes) |idx| if (idx.definition) |def| try ddl.print(arena, "\n\n{s};", .{def});
    for (triggers) |t| try ddl.print(arena, "\n\n{s};", .{t.definition});

    return .{
        .schema = schema,
        .name = name,
        .kind = kind,
        .approx_rows = null,
        .size_bytes = null,
        .comment = null,
        .columns = cols,
        .constraints = try constraintsFrom(arena, name, pk, indexes, fks),
        .indexes = indexes,
        .foreign_keys = fks,
        .referenced_by = refs,
        .triggers = triggers,
        .ddl = ddl.items,
    };
}

/// Primary-key columns in key order, from `pragma_table_info` rows.
fn primaryKey(arena: Allocator, col_res: types.ResultSet) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var ord: usize = 1;
    while (ord <= col_res.rows.len) : (ord += 1) {
        for (col_res.rows) |row| {
            // `pk` is always an integer; treating anything else as "not in the key" is the safe reading.
            const n = std.fmt.parseInt(usize, row[3].?, 10) catch 0;
            if (n == ord) try out.append(arena, row[0].?);
        }
    }
    return out.items;
}

fn readIndexes(conn: *Conn, arena: Allocator, table: []const u8, schema: []const u8, q: []const u8, diag: *Diagnostic) types.Error![]types.Index {
    const list = try conn.runBound(arena, try withSchema(arena,
        \\select il.name, il."unique", il.origin, il.partial, m.sql
        \\from pragma_index_list(?1, ?2) il
        \\left join {s}.sqlite_schema m on m.type = 'index' and m.name = il.name
        \\order by il.origin = 'pk' desc, il.name
    , q), &.{ table, schema }, diag);
    const out = try arena.alloc(types.Index, list.rows.len);
    for (out, list.rows) |*idx, row| {
        const index_name = row[0].?;
        const sql = row[4];
        const keys = try conn.runBound(arena, "select seqno, name from pragma_index_info(?1, ?2) order by seqno", &.{ index_name, schema }, diag);
        const names = try arena.alloc([]const u8, keys.rows.len);
        for (names, keys.rows, 0..) |*n, key, k| {
            n.* = key[1] orelse if (sql) |s| parse.indexKey(s, k) orelse "?" else "?";
        }
        idx.* = .{
            .name = index_name,
            .columns = names,
            .unique = std.mem.eql(u8, row[1].?, "1"),
            .primary = std.mem.eql(u8, row[2].?, "pk"),
            .method = "btree",
            .predicate = if (sql != null and std.mem.eql(u8, row[3].?, "1")) parse.indexPredicate(sql.?) else null,
            .definition = sql,
            .size_bytes = null,
            .scans = null,
        };
    }
    return out;
}

/// Rows `[i..end)` of `rows` that share the values in columns `keys`.
fn groupEnd(rows: []const types.Row, i: usize, keys: []const usize) usize {
    var end = i + 1;
    outer: while (end < rows.len) : (end += 1) {
        for (keys) |k| {
            if (!std.mem.eql(u8, rows[end][k] orelse "", rows[i][k] orelse "")) break :outer;
        }
    }
    return end;
}

fn column(arena: Allocator, rows: []const types.Row, k: usize) Allocator.Error![]const []const u8 {
    const out = try arena.alloc([]const u8, rows.len);
    for (out, rows) |*o, row| o.* = row[k] orelse "";
    return out;
}

/// A reference without a column list means the referenced table's primary key.
fn targetColumns(conn: *Conn, arena: Allocator, rows: []const types.Row, k: usize, ref_table: []const u8, schema: []const u8, diag: *Diagnostic) types.Error![]const []const u8 {
    if (rows[0][k] != null) return column(arena, rows, k);
    const res = try conn.runBound(arena, "select name from pragma_table_info(?1, ?2) where pk > 0 order by pk", &.{ ref_table, schema }, diag);
    return column(arena, res.rows, 0);
}

fn action(text: ?[]const u8) types.FkAction {
    // SQLite spells these exactly as the API does; anything else is its default.
    return types.FkAction.parse(text orelse "") orelse .no_action;
}

fn readForeignKeys(conn: *Conn, arena: Allocator, table: []const u8, schema: []const u8, diag: *Diagnostic) types.Error![]types.ForeignKey {
    const res = try conn.runBound(arena,
        \\select id, seq, "table", "from", "to", on_update, on_delete
        \\from pragma_foreign_key_list(?1, ?2) order by id desc, seq
    , &.{ table, schema }, diag);
    var out: std.ArrayList(types.ForeignKey) = .empty;
    var i: usize = 0;
    while (i < res.rows.len) {
        const end = groupEnd(res.rows, i, &.{0});
        const rows = res.rows[i..end];
        const ref_table = rows[0][2].?;
        const cols = try column(arena, rows, 3);
        try out.append(arena, .{
            .name = try constraintName(arena, table, cols, "fkey"),
            .columns = cols,
            .ref_schema = schema,
            .ref_table = ref_table,
            .ref_columns = try targetColumns(conn, arena, rows, 4, ref_table, schema, diag),
            .on_update = action(rows[0][5]),
            .on_delete = action(rows[0][6]),
        });
        i = end;
    }
    return out.items;
}

fn readReferences(conn: *Conn, arena: Allocator, table: []const u8, schema: []const u8, q: []const u8, pk: []const []const u8, diag: *Diagnostic) types.Error![]types.Reference {
    const res = try conn.runBound(arena, try withSchema(arena,
        \\select m.name, f.id, f."from", f."to", f.on_update, f.on_delete
        \\from {s}.sqlite_schema m join pragma_foreign_key_list(m.name, ?2) f
        \\where m.type = 'table' and f."table" = ?1 collate nocase
        \\order by m.name, f.id desc, f.seq
    , q), &.{ table, schema }, diag);
    var out: std.ArrayList(types.Reference) = .empty;
    var i: usize = 0;
    while (i < res.rows.len) {
        const end = groupEnd(res.rows, i, &.{ 0, 1 });
        const rows = res.rows[i..end];
        const from_table = rows[0][0].?;
        const cols = try column(arena, rows, 2);
        try out.append(arena, .{
            .name = try constraintName(arena, from_table, cols, "fkey"),
            .schema = schema,
            .table = from_table,
            .columns = cols,
            .ref_columns = if (rows[0][3] != null) try column(arena, rows, 3) else pk,
            .on_update = action(rows[0][4]),
            .on_delete = action(rows[0][5]),
        });
        i = end;
    }
    return out.items;
}

/// Postgres's default names (`orders_pkey`, `orders_email_key`, `orders_customer_id_fkey`),
/// since SQLite keeps no names for these.
fn constraintName(arena: Allocator, table: []const u8, cols: []const []const u8, suffix: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(arena, table);
    for (cols) |col| try out.print(arena, "_{s}", .{col});
    try out.print(arena, "_{s}", .{suffix});
    return out.items;
}

fn columnList(arena: Allocator, cols: []const []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (cols, 0..) |col, k| {
        if (k > 0) try out.appendSlice(arena, ", ");
        try out.appendSlice(arena, try Conn.quoteIfNeeded(arena, col));
    }
    return out.items;
}

/// SQLite has no catalog of CHECK constraints, so these come from the key, unique indexes and references.
fn constraintsFrom(arena: Allocator, table: []const u8, pk: []const []const u8, indexes: []const types.Index, fks: []const types.ForeignKey) Allocator.Error![]types.Constraint {
    var out: std.ArrayList(types.Constraint) = .empty;
    if (pk.len > 0) try out.append(arena, .{
        .name = try constraintName(arena, table, &.{}, "pkey"),
        .kind = .primary_key,
        .columns = pk,
        .definition = try std.fmt.allocPrint(arena, "PRIMARY KEY ({s})", .{try columnList(arena, pk)}),
    });
    for (indexes) |idx| {
        // Origin `u`: SQLite made this index for a UNIQUE clause, so it has no SQL of its own.
        if (!idx.unique or idx.primary or idx.definition != null) continue;
        try out.append(arena, .{
            .name = try constraintName(arena, table, idx.columns, "key"),
            .kind = .unique,
            .columns = idx.columns,
            .definition = try std.fmt.allocPrint(arena, "UNIQUE ({s})", .{try columnList(arena, idx.columns)}),
        });
    }
    for (fks) |fk| {
        var def: std.ArrayList(u8) = .empty;
        try def.print(arena, "FOREIGN KEY ({s}) REFERENCES {s}({s})", .{
            try columnList(arena, fk.columns),
            try Conn.quoteIfNeeded(arena, fk.ref_table),
            try columnList(arena, fk.ref_columns),
        });
        if (fk.on_update != .no_action) try def.print(arena, " ON UPDATE {s}", .{fk.on_update.text()});
        if (fk.on_delete != .no_action) try def.print(arena, " ON DELETE {s}", .{fk.on_delete.text()});
        try out.append(arena, .{ .name = fk.name, .kind = .foreign_key, .columns = fk.columns, .definition = def.items });
    }
    return out.items;
}

fn browse(ptr: *anyopaque, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    var deadline: Conn.Deadline = undefined;
    if (req.budget_ms) |ms| {
        deadline = .after(self.io, ms);
        lease.conn.setDeadline(&deadline);
    }
    defer lease.conn.clearDeadline();
    return browseRows(lease.conn, arena, req, diag) catch |err| budgetError(err, req.budget_ms, diag);
}

fn browseRows(conn: *Conn, arena: Allocator, req: types.BrowseRequest, diag: *Diagnostic) types.Error!types.ResultSet {
    var text: std.Io.Writer.Allocating = .init(arena);
    const w = &text.writer;
    w.print("select * from {s}.{s}", .{
        try Conn.quoteIdent(arena, req.table.schema),
        try Conn.quoteIdent(arena, req.table.table),
    }) catch return error.OutOfMemory;
    const compiled = if (req.builder) |b| try builder.compile(arena, b, &dialect, .bind) else builder.Compiled.empty;
    builder.writeWhere(w, req.filter, compiled.where) catch return error.OutOfMemory;
    builder.writeOrder(w, req.order, compiled.order) catch return error.OutOfMemory;
    w.print(" limit {d} offset {d}", .{ req.limit, req.offset }) catch return error.OutOfMemory;
    // Bound values need one prepared statement; a raw filter keeps running every statement as before.
    const limits: types.Limits = .{ .max_rows = req.limit, .max_bytes = req.max_bytes };
    if (req.builder == null) return conn.runAll(arena, text.written(), limits, diag);
    // The builder quotes every column, and a misspelt one must fail rather than compare as a string.
    const dqs = conn.strictIdentifiers();
    defer conn.restoreDoubleQuotedStrings(dqs);
    w.writeByte(0) catch return error.OutOfMemory;
    const z = text.written();
    return conn.runBoundLimited(arena, z[0 .. z.len - 1 :0], compiled.params, limits, diag);
}

fn query(ptr: *anyopaque, arena: Allocator, text: []const u8, options: types.QueryOptions, diag: *Diagnostic) types.Error!types.ResultSet {
    const self = from(ptr);
    const lease = try self.pool.acquire(diag);
    defer lease.release();
    var deadline: Conn.Deadline = undefined;
    if (options.budget_ms) |ms| {
        deadline = .after(self.io, ms);
        lease.conn.setDeadline(&deadline);
    }
    defer lease.conn.clearDeadline();
    return lease.conn.runAll(arena, text, options.limits(), diag) catch |err| budgetError(err, options.budget_ms, diag);
}

/// SQLite only says "interrupted", so a timeout gets the budget it ran past.
fn budgetError(err: types.Error, budget_ms: ?u32, diag: *Diagnostic) types.Error {
    if (err == error.Timeout) if (budget_ms) |ms| diag.print("the statement ran past its {d} ms budget", .{ms});
    return err;
}

test "display name drops the directory and URI parameters" {
    try std.testing.expectEqualStrings("app.db", displayName("/srv/data/app.db", false));
    try std.testing.expectEqualStrings("conf", displayName("file:conf?mode=memory&cache=shared", true));
}
