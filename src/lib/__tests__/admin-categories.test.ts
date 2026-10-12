import { deleteCategory, updateCategory } from '@/lib/admin-categories';

// Updates and deletes of a category (#80) that touch no row. RLS turns a
// write the admin may not make, or one on a row that is gone, into a
// success with no rows rather than an error. An admin sees every row, so no
// row back means nothing was written: that has to fail like an error, or a
// save on a category another admin just deleted looks as if it worked.

type Result = { data: { id: string }[] | null; error: { message: string; code: string } | null };

const mockResult: { current: Result } = { current: { data: [], error: null } };
const mockReturning: { current: boolean } = { current: false };

function mockBuilder() {
  const builder = {
    update: () => builder,
    delete: () => builder,
    eq: () => builder,
    select: () => {
      mockReturning.current = true;
      return builder;
    },
    then<T>(onFulfilled: (value: Result) => T, onRejected?: (reason: unknown) => T) {
      const result = mockReturning.current
        ? mockResult.current
        : { ...mockResult.current, data: null };
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

jest.mock('@/lib/supabase', () => ({ supabase: { from: () => mockBuilder() } }));

const ID = '10000000-0000-4000-8000-000000000001';

beforeEach(() => {
  mockReturning.current = false;
});

describe.each([
  ['updateCategory', () => updateCategory(ID, { published: true })],
  ['deleteCategory', () => deleteCategory(ID)],
])('%s', (_name, write) => {
  it('resolves when a row was written', async () => {
    mockResult.current = { data: [{ id: ID }], error: null };
    await expect(write()).resolves.toBeUndefined();
  });

  it('fails when no row was written', async () => {
    mockResult.current = { data: [], error: null };
    await expect(write()).rejects.toThrow();
  });

  it('fails with the server error', async () => {
    mockResult.current = { data: null, error: { message: 'boom', code: '500' } };
    await expect(write()).rejects.toMatchObject({ message: 'boom' });
  });
});
