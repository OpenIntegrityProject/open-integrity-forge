// CREATE TABLE IF NOT EXISTS leaves a table that already exists as it was, so
// a column added to a schema later never reaches storage created before it.
// Each object adds such columns when it starts.

/** Add a nullable column the table's schema gained after the table was created. */
export function addColumnIfMissing(sql: SqlStorage, table: string, column: string, type: string): void {
  const columns = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (!columns.some((c) => c.name === column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
