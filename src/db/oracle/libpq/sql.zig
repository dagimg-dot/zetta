//! Catalog queries and type names for Postgres.

pub const catalog =
    \\select n.nspname, c.relname, c.relkind::text,
    \\       case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end
    \\from pg_namespace n
    \\left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p', 'v', 'm', 'f')
    \\where n.nspname <> 'information_schema' and n.nspname not like 'pg\_%'
    \\order by n.nspname, c.relname
;

pub const columns =
    \\select a.attname,
    \\       format_type(a.atttypid, a.atttypmod),
    \\       not a.attnotnull,
    \\       coalesce(i.indisprimary, false),
    \\       pg_get_expr(d.adbin, d.adrelid)
    \\from pg_attribute a
    \\join pg_class c on c.oid = a.attrelid
    \\join pg_namespace n on n.oid = c.relnamespace
    \\left join pg_index i on i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey)
    \\left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    \\where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped
    \\order by a.attnum
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
