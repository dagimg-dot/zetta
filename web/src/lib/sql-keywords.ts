/**
 * The keywords of each database, as the server's own lexer classifies them. Postgres's come from
 * src/include/parser/kwlist.h in PostgreSQL 18, SQLite's from the vendored 3.53 amalgamation:
 * reserved words must be quoted to serve as names, and fallback words parse as names wherever a
 * name fits. They stand in for the connected server's own lists.
 */

const words = (list: string) => list.trim().split(/\s+/);

/** Usable as any name. */
export const postgresUnreserved = new Set(
	words(`
	abort absent absolute access action add admin after aggregate also alter always asensitive
	assertion assignment at atomic attach attribute backward before begin breadth by cache call
	called cascade cascaded catalog chain characteristics checkpoint class close cluster columns
	comment comments commit committed compression conditional configuration conflict connection
	constraints content continue conversion copy cost csv cube current cursor cycle data
	database day deallocate declare defaults deferred definer delete delimiter delimiters
	depends depth detach dictionary disable discard document domain double drop each empty
	enable encoding encrypted enforced enum error escape event exclude excluding exclusive
	execute explain expression extension external family filter finalize first following force
	format forward function functions generated global granted groups handler header hold hour
	identity if immediate immutable implicit import include including increment indent index
	indexes inherit inherits inline input insensitive insert instead invoker isolation keep key
	keys label language large last leakproof level listen load local location lock locked logged
	mapping match matched materialized maxvalue merge method minute minvalue mode month move
	name names nested new next nfc nfd nfkc nfkd no normalized nothing notify nowait nulls
	object objects of off oids old omit operator option options ordinality others over
	overriding owned owner parallel parameter parser partial partition passing password path
	period plan plans policy preceding prepare prepared preserve prior privileges procedural
	procedure procedures program publication quote quotes range read reassign recursive ref
	referencing refresh reindex relative release rename repeatable replace replica reset restart
	restrict return returns revoke role rollback rollup routine routines rows rule savepoint
	scalar schema schemas scroll search second security sequence sequences serializable server
	session set sets share show simple skip snapshot source sql stable standalone start
	statement statistics stdin stdout storage stored strict string strip subscription support
	sysid system tables tablespace target temp template temporary text ties transaction
	transform trigger truncate trusted type types uescape unbounded uncommitted unconditional
	unencrypted unknown unlisten unlogged until update vacuum valid validate validator value
	varying version view views virtual volatile whitespace within without work wrapper write xml
	year yes zone
`),
);
/** Usable as a column name, not as a function or type name. */
export const postgresColumnName = new Set(
	words(`
	between bigint bit boolean char character coalesce dec decimal exists extract float greatest
	grouping inout int integer interval json json_array json_arrayagg json_exists json_object
	json_objectagg json_query json_scalar json_serialize json_table json_value least
	merge_action national nchar none normalize nullif numeric out overlay position precision
	real row setof smallint substring time timestamp treat trim values varchar xmlattributes
	xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize
	xmltable
`),
);
/** Usable as a function or type name, not as a column name. */
export const postgresTypeFunctionName = new Set(
	words(`
	authorization binary collation concurrently cross current_schema freeze full ilike inner is
	isnull join left like natural notnull outer overlaps right similar tablesample verbose
`),
);
/** Usable as a name only when quoted, or as a column alias after AS. */
export const postgresReserved = new Set(
	words(`
	all analyse analyze and any array as asc asymmetric both case cast check collate column
	constraint create current_catalog current_date current_role current_time current_timestamp
	current_user default deferrable desc distinct do else end except false fetch for foreign
	from grant group having in initially intersect into lateral leading limit localtime
	localtimestamp not null offset on only or order placing primary references returning select
	session_user some symmetric system_user table then to trailing true union unique user using
	variadic when where window with
`),
);

/** Must be quoted to serve as a name. */
export const sqliteReserved = new Set(
	words(`
	add all alter and as autoincrement between case check collate commit constraint create
	default deferrable delete distinct drop else escape exists foreign from group having in
	index insert into is isnull join limit not nothing notnull null on or order primary
	references returning select set table then to transaction unique update using values when
	where
`),
);
/** Parse as a name wherever a name fits. */
export const sqliteFallback = new Set(
	words(`
	abort action after always analyze asc attach before begin by cascade cast column conflict
	cross current current_date current_time current_timestamp database deferred desc detach do
	each end except exclude exclusive explain fail filter first following for full generated
	glob groups if ignore immediate indexed initially inner instead intersect key last left like
	match materialized natural no nulls of offset others outer over partition plan pragma
	preceding query raise range recursive regexp reindex release rename replace restrict right
	rollback row rows savepoint temp temporary ties trigger unbounded union vacuum view virtual
	window with without
`),
);

/** Built-in functions people type in full, which no catalog lists. Not a complete list. */
export const commonFunctions = new Set(
	words(`
	abs array_agg avg ceil ceiling coalesce concat count date date_part date_trunc datetime
	dense_rank extract first_value floor greatest group_concat if ifnull iif instr json_agg
	jsonb_agg julianday lag last_value lead least left length lower ltrim max min mod now nullif
	power printf random rank replace right round row_number rtrim sqrt strftime string_agg substr
	substring sum to_char to_date to_timestamp trim typeof upper
`),
);
