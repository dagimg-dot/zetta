import postgresDark from "./assets/postgres-dark.png";
import postgresLight from "./assets/postgres-light.png";
import sqliteDark from "./assets/sqlite-dark.png";
import sqliteLight from "./assets/sqlite-light.png";

export const screens = {
	postgres: {
		light: postgresLight,
		dark: postgresDark,
		alt: "zetta on Postgres: a filtered and sorted table, with the inspector following a foreign key",
		caption: "Schemas, views and functions, a filtered and sorted table, and a foreign key followed.",
	},
	sqlite: {
		light: sqliteLight,
		dark: sqliteDark,
		alt: "zetta on SQLite: a query in the SQL editor, its results, and a JSON value formatted in the inspector",
		caption: "A query in the SQL editor, its results, and a JSON value formatted in the inspector.",
	},
};
