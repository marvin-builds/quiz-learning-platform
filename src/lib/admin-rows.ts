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

/**
 * Whether the database refused a write by one of its rules (SQLSTATE 23514,
 * check_violation), e.g. the answer or publish rules (#82), as opposed to a
 * failure worth retrying.
 */
export const isRuleViolation = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === '23514';
