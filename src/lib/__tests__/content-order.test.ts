import { fetchCategories, fetchCategoryWithQuizzes } from '@/lib/content';

// The order of the learner's lists (#84): the home screen's categories and a
// category's quizzes come by sort_order with the id as a tiebreak, like the
// questions and answers of the player already do, so the order is stable
// whatever the database returns for equal positions. A reorder renumbers
// 1..n, so there are no ties after one; rows with equal positions from
// before (or written by hand) must still come in a fixed order.
//
// Boundary: the Supabase client (network), faked like
// src/__tests__/quiz-screen.test.tsx: filters, `order` (also on embedded
// tables via `referencedTable`) and embeds. Rows with equal sort_order come
// back in table order unless the query orders by id too, so the tables
// below store them against id order on purpose.

type Row = Record<string, unknown>;
type PostgrestError = {
  message: string;
  code: string;
  details?: string | null;
  hint?: string | null;
};
type Result = { data: unknown; error: PostgrestError | null; count?: number | null };
type ReadState = 'ok' | 'pending' | { error: PostgrestError };
type Field = { key: string; column: string; inner?: boolean; embed?: Field[] };
type Order = { column: string; ascending: boolean; referencedTable?: string };
type Query = {
  table: string;
  select?: string;
  head: boolean;
  count: boolean;
  orders: Order[];
  filters: { column: string; values: unknown[] }[];
  mode: 'many' | 'maybeSingle' | 'single';
};

const mockDb: Record<string, Row[]> = {
  categories: [],
  quizzes: [],
  questions: [],
  answers: [],
  attempts: [],
  profiles: [],
};
const mockRead: { detail: ReadState; content: ReadState } = { detail: 'ok', content: 'ok' };
const mockQueries: Query[] = [];
const mockRpcHandlers: Record<string, (args: Row) => Promise<Result>> = {};
const mockRpcCalls: { name: string; args: Row }[] = [];
const mockLog: string[] = [];
const mockWrites: string[] = [];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARENT_KEY: Record<string, string> = { questions: 'quiz_id', answers: 'question_id' };
// To-one embeds: the column of the embedding row that references the embedded one.
const REFERENCE_KEY: Record<string, string> = { categories: 'category_id' };
const HIDDEN_COLUMNS: Record<string, string[]> = {
  questions: ['explanation', '*'],
  answers: ['is_correct', '*'],
};

function mockSplitTopLevel(select: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of select) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

function mockParseFields(select: string): Field[] {
  return mockSplitTopLevel(select).map((item) => {
    const match = /^(?:(\w+):)?([\w*]+)(?:!(\w+))?(?:\(([\s\S]*)\))?$/.exec(item);
    if (!match) throw new Error(`The fake client can't parse the select item "${item}"`);
    const [, alias, column, hint, body] = match;
    return {
      key: alias ?? column,
      column,
      inner: hint === 'inner',
      embed: body === undefined ? undefined : mockParseFields(body),
    };
  });
}

function mockTouches(
  table: string,
  fields: Field[],
  visit: (table: string, field: Field) => boolean,
): boolean {
  return fields.some((field) =>
    field.embed ? mockTouches(field.column, field.embed, visit) : visit(table, field),
  );
}

// A count-only embed counts with a `select` on the whole row, which the
// column grants of questions and answers refuse.
function mockHasCountOnlyEmbed(fields: Field[]): boolean {
  return fields.some(
    (field) =>
      field.embed !== undefined &&
      ((field.column in HIDDEN_COLUMNS &&
        field.embed.length === 1 &&
        field.embed[0].column === 'count' &&
        !field.embed[0].embed) ||
        mockHasCountOnlyEmbed(field.embed)),
  );
}

const mockIsDenied = (table: string, fields: Field[]) =>
  mockHasCountOnlyEmbed(fields) ||
  mockTouches(table, fields, (t, field) => HIDDEN_COLUMNS[t]?.includes(field.column) ?? false);

const mockUsesAggregate = (select: string) =>
  /\.\s*\w+\s*\(\s*\)|(^|[\s,(])count\s*\(\s*\)/.test(select);

const mockIsContent = (table: string, fields: Field[]) =>
  table === 'answers' ||
  mockTouches(
    table,
    fields,
    (t, field) => t === 'answers' || (t === 'questions' && field.column === 'text'),
  );

function mockSort(rows: Row[], orders: Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const [x, y] = [a[column], b[column]] as [string | number, string | number];
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}

function mockChildren(table: string, parent: Row): Row[] {
  const key = PARENT_KEY[table];
  if (!key) throw new Error(`The fake client can't embed ${table}`);
  return (mockDb[table] ?? []).filter((row) => row[key] === parent.id);
}

// Whether a row at `path` passes the filters on that path: `id` at the top,
// `categories.published` for the embedded category.
function mockMatches(row: Row, query: Query, path: string[]): boolean {
  return query.filters.every(({ column, values }) => {
    const segments = column.split('.');
    const name = segments.pop()!;
    return segments.join('.') !== path.join('.') || values.includes(row[name]);
  });
}

// `path` is the embed path from the queried table (e.g. `questions.answers`);
// an embedded order names either that path or its last segment. Null: an
// `!inner` embed has no row left, so the row itself drops out.
function mockProject(row: Row, fields: Field[], query: Query, path: string[] = []): Row | null {
  const projected: Row = {};
  for (const field of fields) {
    if (field.embed) {
      const childPath = [...path, field.column];
      const referenceKey = REFERENCE_KEY[field.column];
      if (referenceKey) {
        const referenced = (mockDb[field.column] ?? []).find(
          (other) => other.id === row[referenceKey] && mockMatches(other, query, childPath),
        );
        const embedded = referenced ? mockProject(referenced, field.embed, query, childPath) : null;
        if (field.inner && !embedded) return null;
        projected[field.key] = embedded;
        continue;
      }
      const children = mockSort(
        mockChildren(field.column, row).filter((child) => mockMatches(child, query, childPath)),
        query.orders.filter(
          (order) =>
            order.referencedTable === childPath.join('.') || order.referencedTable === field.column,
        ),
      )
        .map((child) => mockProject(child, field.embed!, query, childPath))
        .filter((child): child is Row => child !== null);
      if (field.inner && children.length === 0) return null;
      projected[field.key] = children;
    } else if (field.column === '*') {
      Object.assign(projected, row);
    } else {
      projected[field.key] = row[field.column];
    }
  }
  return projected;
}

function mockRespond(query: Query): Promise<Result> {
  const invalidId = query.filters.find(
    ({ column, values }) =>
      /(^|_)id$/.test(column) && values.some((value) => !UUID.test(String(value))),
  );
  if (invalidId) {
    return Promise.resolve({
      data: null,
      error: {
        code: '22P02',
        message: `invalid input syntax for type uuid: "${invalidId.values}"`,
      },
    });
  }

  if (mockUsesAggregate(query.select ?? '')) {
    return Promise.resolve({
      data: null,
      error: { code: 'PGRST123', message: 'Use of aggregate functions is not allowed' },
    });
  }
  const fields = mockParseFields(query.select ?? '*');
  if (mockIsDenied(query.table, fields)) {
    return Promise.resolve({
      data: null,
      error: { code: '42501', message: `permission denied for table ${query.table}` },
    });
  }

  const state = mockIsContent(query.table, fields) ? mockRead.content : mockRead.detail;
  if (state === 'pending') return new Promise(() => {});
  if (state !== 'ok') return Promise.resolve({ data: null, error: state.error });

  const rows = mockSort(
    (mockDb[query.table] ?? []).filter((row) => mockMatches(row, query, [])),
    query.orders.filter((order) => !order.referencedTable),
  )
    .map((row) => mockProject(row, fields, query))
    .filter((row): row is Row => row !== null);

  const count = query.count ? rows.length : null;
  if (query.mode === 'many') {
    return Promise.resolve({ data: query.head ? null : rows, error: null, count });
  }
  if (rows.length > 1) {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } });
  }
  if (rows.length === 0 && query.mode === 'single') {
    return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
  }
  return Promise.resolve({ data: rows[0] ?? null, error: null });
}

function mockThen<T>(
  result: Promise<Result>,
  throwOnError: boolean,
  onFulfilled: (value: Result) => T,
  onRejected?: (reason: unknown) => T,
) {
  return result
    .then((response) => {
      if (throwOnError && response.error) throw response.error;
      return response;
    })
    .then(onFulfilled, onRejected);
}

// Any write is recorded and refused; the preview must send none.
function mockWrite(table: string, operation: string) {
  mockWrites.push(`${operation}:${table}`);
  const refused = Promise.resolve({
    data: null,
    error: { code: '42501', message: `the preview must not ${operation} ${table}` },
  });
  const chain: Record<string, unknown> = {
    then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
      refused.then(onFulfilled, onRejected),
  };
  for (const method of ['select', 'eq', 'in', 'match', 'single', 'maybeSingle', 'abortSignal']) {
    chain[method] = () => chain;
  }
  return chain;
}

function mockQueryBuilder(table: string) {
  const query: Query = {
    table,
    head: false,
    count: false,
    orders: [],
    filters: [],
    mode: 'many',
  };
  let throwOnError = false;
  const builder = {
    select(columns?: string, options?: { head?: boolean; count?: string }) {
      query.select = columns;
      query.head = options?.head === true;
      query.count = options?.count !== undefined;
      return builder;
    },
    order(
      column: string,
      options?: { ascending?: boolean; referencedTable?: string; foreignTable?: string },
    ) {
      query.orders.push({
        column,
        ascending: options?.ascending !== false,
        referencedTable: options?.referencedTable ?? options?.foreignTable,
      });
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push({ column, values: [value] });
      return builder;
    },
    in(column: string, values: unknown[]) {
      query.filters.push({ column, values });
      return builder;
    },
    maybeSingle() {
      query.mode = 'maybeSingle';
      return builder;
    },
    single() {
      query.mode = 'single';
      return builder;
    },
    insert: () => mockWrite(table, 'insert'),
    update: () => mockWrite(table, 'update'),
    upsert: () => mockWrite(table, 'upsert'),
    delete: () => mockWrite(table, 'delete'),
    abortSignal: () => builder,
    limit: () => builder,
    returns: () => builder,
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      mockQueries.push(query);
      mockLog.push(`from:${table}`);
      return mockThen(mockRespond(query), throwOnError, onFulfilled, onRejected);
    },
  };
  return builder;
}

function mockRpc(name: string, args: Row) {
  let single = false;
  let throwOnError = false;
  const builder = {
    single() {
      single = true;
      return builder;
    },
    maybeSingle() {
      single = true;
      return builder;
    },
    abortSignal: () => builder,
    returns: () => builder,
    throwOnError() {
      throwOnError = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      mockRpcCalls.push({ name, args });
      mockLog.push(`rpc:${name}`);
      const handler = mockRpcHandlers[name];
      const result = (
        handler
          ? handler(args)
          : Promise.resolve({
              data: null,
              error: { code: 'PGRST202', message: 'no such function' },
            })
      ).then((response) =>
        single && Array.isArray(response.data)
          ? { ...response, data: response.data[0] ?? null }
          : response,
      );
      return mockThen(result, throwOnError, onFulfilled, onRejected);
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (name: string, args: Row) => mockRpc(name, args),
  },
}));

// The rows at position 2 have lower ids than those at position 1, so only
// sort_order first, then id, gives the expected order (id first would not).
const KUNST = '10000000-0000-4000-8000-000000000001';
const MUSIK = '10000000-0000-4000-8000-000000000002';
const GEOGRAFIE = '10000000-0000-4000-8000-000000000003';
const GESCHICHTE = '10000000-0000-4000-8000-000000000004';

const category = (id: string, name: string, sort_order: number) => ({
  id,
  name,
  description: null,
  sort_order,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
});

const quiz = (id: string, title: string, sort_order: number) => ({
  id,
  category_id: GEOGRAFIE,
  title,
  description: null,
  sort_order,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  mockRead.detail = 'ok';
  mockRead.content = 'ok';
  mockQueries.length = 0;
  // Geschichte and Geografie share position 1, Kunst and Musik position 2,
  // each pair stored against id order; the position-2 rows have the lowest ids.
  mockDb.categories = [
    category(KUNST, 'Kunst', 2),
    category(GESCHICHTE, 'Geschichte', 1),
    category(MUSIK, 'Musik', 2),
    category(GEOGRAFIE, 'Geografie', 1),
  ];
  mockDb.quizzes = [
    quiz('20000000-0000-4000-8000-000000000001', 'Gebirge', 2),
    quiz('20000000-0000-4000-8000-000000000003', 'Flüsse', 1),
    quiz('20000000-0000-4000-8000-000000000002', 'Hauptstädte', 1),
  ];
});

describe('learner content order', () => {
  it('lists the categories by sort_order, equal positions by id', async () => {
    const categories = await fetchCategories();

    expect(categories.map((row) => row.name)).toEqual([
      'Geografie',
      'Geschichte',
      'Kunst',
      'Musik',
    ]);
  });

  it('lists a category’s quizzes by sort_order, equal positions by id', async () => {
    const found = await fetchCategoryWithQuizzes(GEOGRAFIE);

    expect(found?.quizzes.map((row) => row.title)).toEqual(['Hauptstädte', 'Flüsse', 'Gebirge']);
  });
});
