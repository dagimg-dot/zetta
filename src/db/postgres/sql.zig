//! Catalog queries and type names for Postgres.

pub const catalog =
    \\select n.nspname, c.relname, c.relkind::text,
    \\       case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end
    \\from pg_namespace n
    \\left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p', 'v', 'm', 'f')
    \\where n.nspname <> 'information_schema' and n.nspname not like 'pg\_%'
    \\order by n.nspname, c.relname
;

/// The last four columns (comment, quoted name, identity, generated) feed the table detail.
pub const columns =
    \\select a.attname,
    \\       format_type(a.atttypid, a.atttypmod),
    \\       not a.attnotnull,
    \\       coalesce(i.indisprimary, false),
    \\       pg_get_expr(d.adbin, d.adrelid),
    \\       col_description(c.oid, a.attnum),
    \\       quote_ident(a.attname),
    \\       a.attidentity::text,
    \\       a.attgenerated::text
    \\from pg_attribute a
    \\join pg_class c on c.oid = a.attrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\left join pg_index i on i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)
    \\left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    \\where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
    \\order by a.attnum
;

pub const relation_exists =
    \\select 1 from pg_class c
    \\join pg_namespace n on n.oid = c.relnamespace
    \\where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')
;

/// Every detail query takes the schema as $1 and the table as $2.
pub const detail_table =
    \\select n.nspname, c.relname, c.relkind::text,
    \\       case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end,
    \\       case when c.relkind in ('r', 'p', 'm') then pg_total_relation_size(c.oid) end,
    \\       case when c.relkind in ('r', 'p', 'm') then pg_relation_size(c.oid) end,
    \\       case when c.relkind in ('r', 'p', 'm') then pg_indexes_size(c.oid) end,
    \\       obj_description(c.oid, 'pg_class'),
    \\       case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end,
    \\       format('%I.%I', n.nspname, c.relname),
    \\       case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end
    \\from pg_class c
    \\join pg_namespace n on n.oid = c.relnamespace
    \\where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')
;

/// A JSON array of the names of attribute numbers `keys` on relation `rel`, in key order.
fn attnames(comptime keys: []const u8, comptime rel: []const u8) []const u8 {
    return "coalesce((select json_agg(a.attname order by k.ord) from unnest(" ++ keys ++
        ") with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = " ++ rel ++
        " and a.attnum = k.attnum), '[]')::text";
}

pub const detail_constraints =
    \\select con.conname, con.contype::text, pg_get_constraintdef(con.oid, true),
++ "       " ++ attnames("con.conkey", "con.conrelid") ++ ",\n" ++
    \\       quote_ident(con.conname)
    \\from pg_constraint con
    \\join pg_class c on c.oid = con.conrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\where n.nspname = $1 and c.relname = $2 and con.contype in ('p', 'u', 'f', 'c', 'x')
    \\order by case con.contype when 'p' then 0 when 'u' then 1 when 'f' then 2 when 'c' then 3 else 4 end, con.conname
;

pub const detail_foreign_keys =
    \\select con.conname, rn.nspname, rc.relname,
++ "       " ++ attnames("con.conkey", "con.conrelid") ++ ",\n" ++
    "       " ++ attnames("con.confkey", "con.confrelid") ++ ",\n" ++
    \\       con.confupdtype::text, con.confdeltype::text
    \\from pg_constraint con
    \\join pg_class c on c.oid = con.conrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\join pg_class rc on rc.oid = con.confrelid
    \\join pg_namespace rn on rn.oid = rc.relnamespace
    \\where con.contype = 'f' and n.nspname = $1 and c.relname = $2
    \\order by con.conname
;

/// Constraints copied onto partitions (conparentid <> 0) would list one reference many times.
pub const detail_referenced_by =
    \\select con.conname, cn.nspname, cc.relname,
++ "       " ++ attnames("con.conkey", "con.conrelid") ++ ",\n" ++
    "       " ++ attnames("con.confkey", "con.confrelid") ++ ",\n" ++
    \\       con.confupdtype::text, con.confdeltype::text
    \\from pg_constraint con
    \\join pg_class t on t.oid = con.confrelid
    \\join pg_namespace tn on tn.oid = t.relnamespace
    \\join pg_class cc on cc.oid = con.conrelid
    \\join pg_namespace cn on cn.oid = cc.relnamespace
    \\where con.contype = 'f' and con.conparentid = 0 and tn.nspname = $1 and t.relname = $2
    \\order by cn.nspname, cc.relname, con.conname
;

/// The last column says whether a constraint owns the index, so the DDL leaves it out.
pub const detail_indexes =
    \\select ic.relname, i.indisunique, i.indisprimary, am.amname,
    \\       pg_get_expr(i.indpred, i.indrelid, true),
    \\       pg_get_indexdef(i.indexrelid),
    \\       pg_relation_size(i.indexrelid),
    \\       s.idx_scan,
    \\       (select json_agg(pg_get_indexdef(i.indexrelid, k, true) order by k)
    \\          from generate_series(1, i.indnkeyatts::int) k)::text,
    \\       exists (select 1 from pg_constraint con where con.conindid = i.indexrelid
    \\               and con.conrelid = i.indrelid and con.contype in ('p', 'u', 'x'))
    \\from pg_index i
    \\join pg_class c on c.oid = i.indrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\join pg_class ic on ic.oid = i.indexrelid
    \\join pg_am am on am.oid = ic.relam
    \\left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
    \\where n.nspname = $1 and c.relname = $2
    \\order by i.indisprimary desc, ic.relname
;

pub const detail_triggers =
    \\select t.tgname, t.tgtype::int, t.tgfoid::regproc::text, pg_get_triggerdef(t.oid, true), t.tgenabled <> 'D'
    \\from pg_trigger t
    \\join pg_class c on c.oid = t.tgrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\where n.nspname = $1 and c.relname = $2 and not t.tgisinternal
    \\order by t.tgname
;

/// Members of an extension are left out: a database with PostGIS would otherwise list thousands.
pub const catalog_functions =
    \\select n.nspname, p.proname, p.prokind::text,
    \\       pg_get_function_identity_arguments(p.oid),
    \\       case when p.prokind <> 'p' then pg_get_function_result(p.oid) end
    \\from pg_proc p
    \\join pg_namespace n on n.oid = p.pronamespace
    \\where n.nspname <> 'information_schema' and n.nspname not like 'pg\_%'
    \\  and not exists (select 1 from pg_depend d
    \\                  where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    \\order by n.nspname, p.proname, 4
;

/// $1 is the schema, $2 the name and $3 the identity arguments, which together pick one overload.
pub const function_detail =
    \\with f as (
    \\  select p.*, n.nspname,
    \\         pg_get_function_identity_arguments(p.oid) as identity,
    \\         format('%I.%I', n.nspname, p.proname) as quoted
    \\  from pg_proc p
    \\  join pg_namespace n on n.oid = p.pronamespace
    \\  where n.nspname = $1 and p.proname = $2
    \\), a as (
    \\  select f.*, case when f.identity = '' then '' else '/* ' || f.identity || ' */' end as hole
    \\  from f where f.identity = $3
    \\)
    \\select a.nspname, a.proname, a.prokind::text, a.identity,
    \\       pg_get_function_arguments(a.oid),
    \\       case when a.prokind <> 'p' then pg_get_function_result(a.oid) end,
    \\       l.lanname, a.provolatile::text, a.proisstrict, a.prosecdef,
    \\       pg_get_userbyid(a.proowner),
    \\       obj_description(a.oid, 'pg_proc'),
    \\       case when a.prokind <> 'a' then pg_get_functiondef(a.oid) end,
    \\       case
    \\         when a.prorettype in ('trigger'::regtype, 'event_trigger'::regtype) then null
    \\         when a.prokind = 'p' then format('call %s(%s);', a.quoted, a.hole)
    \\         when a.prokind = 'a' then format('select %s(%s);', a.quoted, a.hole)
    \\         when a.prokind = 'w' then format('select %s(%s) over ();', a.quoted, a.hole)
    \\         else format('select * from %s(%s);', a.quoted, a.hole)
    \\       end
    \\from a
    \\join pg_language l on l.oid = a.prolang
;

pub const type_name_lookup = "select format_type($1::oid, null)";

/// Short names for the built-in types, so most result sets need no lookup.
pub fn builtinTypeName(oid: c_uint) ?[]const u8 {
    return switch (oid) {
        16 => "boolean",
        17 => "bytea",
        18 => "char",
        19 => "name",
        20 => "bigint",
        21 => "smallint",
        23 => "integer",
        25 => "text",
        26 => "oid",
        114 => "json",
        142 => "xml",
        650 => "cidr",
        700 => "real",
        701 => "double precision",
        790 => "money",
        829 => "macaddr",
        869 => "inet",
        1000 => "boolean[]",
        1005 => "smallint[]",
        1007 => "integer[]",
        1009 => "text[]",
        1015 => "varchar[]",
        1016 => "bigint[]",
        1021 => "real[]",
        1022 => "double precision[]",
        1042 => "char",
        1043 => "varchar",
        1082 => "date",
        1083 => "time",
        1114 => "timestamp",
        1184 => "timestamptz",
        1186 => "interval",
        1266 => "timetz",
        1560 => "bit",
        1562 => "varbit",
        1700 => "numeric",
        2950 => "uuid",
        2951 => "uuid[]",
        3614 => "tsvector",
        3802 => "jsonb",
        3807 => "jsonb[]",
        else => null,
    };
}
