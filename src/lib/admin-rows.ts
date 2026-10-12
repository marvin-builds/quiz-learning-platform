// Helpers for the admin's reads and writes of content rows.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id from the route can name a row at all; others are not asked for. */
export const isUuid = (id: string | undefined): id is string => id !== undefined && UUID.test(id);

// RLS turns a write on a row that is gone (or one the user may no longer
// make) into a success with no rows. An admin sees every row, so no row back
// means nothing was written, which has to fail like an error.
export function requireWritten(data: unknown[] | null) {
  if (!data || data.length === 0) throw new Error('No row was written');
}
