import { fetchAdminCategories } from '@/lib/admin-categories';
import { fetchQuizQuestions } from '@/lib/admin-questions';
import { fetchCategoryQuizzes } from '@/lib/admin-quizzes';

// The order of the admin's lists (#84): categories, a category's quizzes and
// a quiz's questions come by sort_order with the id as a tiebreak, like the
// learner's lists (content-order.test.ts). Otherwise rows with equal
// positions (from before a reorder, or written by hand) could come in a
// different order for the admin than for the learner, and the preview,
// which reuses fetchQuizQuestions, could differ from the player.
//
// Boundary: the Supabase client (network), faked with just the calls these
// fetchers make (select, eq, order, maybeSingle). Rows with equal sort_order
// come back in table order unless the query orders by id too, so the tables
// below store them against id order on purpose.

type Row = Record<string, unknown>;
type Order = { column: string; ascending: boolean };

const mockDb: Record<string, Row[]> = { categories: [], quizzes: [], questions: [] };

function mockSort(rows: Row[], orders: Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const [x, y] = [a[column], b[column]] as [string | number, string | number];
      if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
    }
    return 0;
  });
}

function mockQueryBuilder(table: string) {
  const orders: Order[] = [];
  const filters: [string, unknown][] = [];
  let single = false;
  const builder = {
    select: () => builder,
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      orders.push({ column, ascending: options?.ascending !== false });
      return builder;
    },
    maybeSingle() {
      single = true;
      return builder;
    },
    then<T>(onFulfilled: (value: { data: unknown; error: null }) => T) {
      const rows = mockSort(
        mockDb[table].filter((row) => filters.every(([column, value]) => row[column] === value)),
        orders,
      );
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(
        onFulfilled,
      );
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => mockQueryBuilder(table) },
}));

const CATEGORY = '10000000-0000-4000-8000-000000000003';
const QUIZ = '20000000-0000-4000-8000-000000000002';

beforeEach(() => {
  // Within each pair of equal positions the higher id is stored first, and
  // the position-2 rows have the lowest ids.
  mockDb.categories = [
    { id: '10000000-0000-4000-8000-000000000001', name: 'Kunst', sort_order: 2 },
    { id: '10000000-0000-4000-8000-000000000004', name: 'Geschichte', sort_order: 1 },
    { id: '10000000-0000-4000-8000-000000000002', name: 'Musik', sort_order: 2 },
    { id: CATEGORY, name: 'Geografie', sort_order: 1 },
  ];
  mockDb.quizzes = [
    {
      id: '20000000-0000-4000-8000-000000000001',
      category_id: CATEGORY,
      title: 'Gebirge',
      sort_order: 2,
    },
    {
      id: '20000000-0000-4000-8000-000000000003',
      category_id: CATEGORY,
      title: 'Flüsse',
      sort_order: 1,
    },
    { id: QUIZ, category_id: CATEGORY, title: 'Hauptstädte', sort_order: 1 },
  ];
  mockDb.questions = [
    { id: '30000000-0000-4000-8000-000000000001', quiz_id: QUIZ, text: 'Dritte', sort_order: 2 },
    { id: '30000000-0000-4000-8000-000000000003', quiz_id: QUIZ, text: 'Zweite', sort_order: 1 },
    { id: '30000000-0000-4000-8000-000000000002', quiz_id: QUIZ, text: 'Erste', sort_order: 1 },
  ];
});

describe('admin content order', () => {
  it('lists the categories by sort_order, equal positions by id', async () => {
    const categories = await fetchAdminCategories();

    expect(categories.map((row) => row.name)).toEqual([
      'Geografie',
      'Geschichte',
      'Kunst',
      'Musik',
    ]);
  });

  it('lists a category’s quizzes by sort_order, equal positions by id', async () => {
    const found = await fetchCategoryQuizzes(CATEGORY);

    expect(found?.quizzes.map((row) => row.title)).toEqual(['Hauptstädte', 'Flüsse', 'Gebirge']);
  });

  it('lists a quiz’s questions by sort_order, equal positions by id', async () => {
    const found = await fetchQuizQuestions(QUIZ);

    expect(found?.questions.map((row) => row.text)).toEqual(['Erste', 'Zweite', 'Dritte']);
  });
});
