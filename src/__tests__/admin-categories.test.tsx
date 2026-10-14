// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// The admin's category screens (#80), rendered through the real route tree
// in src/app with expo-router's renderRouter, behind the admin guard:
// - `/admin/categories`: every category by sort_order, unpublished ones
//   included, each with its published state, a publish/unpublish action, an
//   edit link and a delete action with an in-app confirmation dialog; with
//   loading, empty and error-with-retry states.
// - `/admin/categories/new` and `/admin/categories/<id>/edit`: the create and edit
//   form (name, description, published), with a pending state while saving
//   and an error that keeps the input.
//
// Boundary: the Supabase client (network). The fake answers like the local
// stack does to the seed admin:
// - `auth` holds the admin's session; `from('profiles')` returns the role.
// - `from('categories')` is an in-memory table with the database's rules:
//   reads apply `eq` filters and `order` (no order, no sorting: the rows are
//   stored out of order on purpose); inserts and updates may only write name,
//   description and published (anything else: 42501, like the column
//   grants), a blank name is rejected (23514), and an insert gets the next
//   sort_order. `mockServer` fails or holds reads and writes.
// Every write is recorded in `mockWrites`, and every query on categories, in
// order, in `mockCalls`.

// The language the screens currently show.
const shown = (): 'de' | 'en' => (i18n.language === 'en' ? 'en' : 'de');

// Reads a text from de.json or en.json by path (by default in the language
// shown), so keys that don't exist yet fail at run time with their name
// instead of breaking the typecheck.
function text(key: string, lng: 'de' | 'en' = shown()): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

// A text with its placeholders filled in, through i18next, so it reads like
// the screen's `t(key, { name })`. Checks the key exists first.
function label(key: string, values: Record<string, string> = {}, lng: 'de' | 'en' = shown()) {
  text(key, lng);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng });
}

type User = {
  id: string;
  email?: string;
  is_anonymous: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
};
type Session = { access_token: string; refresh_token: string; user: User };
type PostgrestError = { message: string; code: string; details?: string; hint?: string };
type Category = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  published: boolean;
  created_at: string;
};
type Operation = 'select' | 'insert' | 'update' | 'delete';
type Query = {
  table: string;
  operation: Operation;
  values?: unknown;
  filters: [string, unknown][];
  orders: [string, { ascending?: boolean } | undefined][];
  returning: boolean;
};
type Write = { operation: Operation; values?: unknown; filters: [string, unknown][] };
type Listener = (event: string, session: Session | null) => void;
type ServerState = 'ok' | 'pending' | { error: PostgrestError };

const ADMIN: User = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
const LEARNER: User = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  email: 'learner@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};

const GEOGRAFIE: Category = {
  id: '10000000-0000-4000-8000-000000000001',
  name: 'Geografie',
  description: 'Länder, Städte und Flüsse',
  sort_order: 1,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const NATURWISSENSCHAFTEN: Category = {
  id: '10000000-0000-4000-8000-000000000002',
  name: 'Naturwissenschaften',
  description: 'Chemie, Physik und Biologie',
  sort_order: 2,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const GESCHICHTE: Category = {
  id: '10000000-0000-4000-8000-000000000003',
  name: 'Geschichte',
  description: null,
  sort_order: 3,
  published: true,
  created_at: '2026-10-01T00:00:00Z',
};
const MUSIK: Category = {
  id: '10000000-0000-4000-8000-000000000004',
  name: 'Musik',
  description: 'Komponisten und Instrumente',
  sort_order: 4,
  published: false,
  created_at: '2026-10-01T00:00:00Z',
};
const NAMES = /^(Geografie|Naturwissenschaften|Geschichte|Musik)$/;

const WRITABLE = ['name', 'description', 'published'];
const NETWORK_ERROR: PostgrestError = { message: 'TypeError: Failed to fetch', code: '' };

const mockAuth = {
  session: null as Session | null,
  listeners: new Set<Listener>(),
};
const mockProfiles: Record<string, 'learner' | 'admin'> = {};
const mockCategories: Category[] = [];
const mockServer: Record<Operation, ServerState> = {
  select: 'ok',
  insert: 'ok',
  update: 'ok',
  delete: 'ok',
};
const mockHeld: (() => void)[] = [];
const mockWrites: Write[] = [];
const mockCalls: Write[] = [];
let mockNextId = 1;

function mockRelease() {
  for (const release of mockHeld.splice(0)) release();
}

function mockPermissionDenied() {
  return {
    data: null,
    error: { message: 'permission denied for table categories', code: '42501' },
  };
}

function mockIsBlank(value: unknown) {
  return typeof value !== 'string' || value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') === '';
}

function mockMatches(row: Record<string, unknown>, filters: [string, unknown][]) {
  return filters.every(([column, value]) => row[column] === value);
}

function mockApplyCategories(query: Query): { data: unknown; error: PostgrestError | null } {
  if (query.operation === 'select') {
    const rows = mockCategories.filter((row) => mockMatches(row, query.filters));
    for (const [column, options] of [...query.orders].reverse()) {
      const direction = options?.ascending === false ? -1 : 1;
      rows.sort((a, b) => {
        const left = a[column as keyof Category] as number | string;
        const right = b[column as keyof Category] as number | string;
        return left < right ? -direction : left > right ? direction : 0;
      });
    }
    return { data: rows.map((row) => ({ ...row })), error: null };
  }

  mockWrites.push({ operation: query.operation, values: query.values, filters: query.filters });

  if (query.operation === 'insert') {
    const inserted: Category[] = [];
    const list = Array.isArray(query.values) ? query.values : [query.values];
    for (const values of list as Record<string, unknown>[]) {
      if (Object.keys(values).some((column) => !WRITABLE.includes(column))) {
        return mockPermissionDenied();
      }
      if (mockIsBlank(values.name)) {
        return { data: null, error: { message: 'categories_name_check', code: '23514' } };
      }
      const row: Category = {
        id: `90000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`,
        name: values.name as string,
        description: (values.description as string | null | undefined) ?? null,
        sort_order: Math.max(0, ...mockCategories.map((category) => category.sort_order)) + 1,
        published: (values.published as boolean | undefined) ?? false,
        created_at: '2026-10-12T00:00:00Z',
      };
      mockCategories.push(row);
      inserted.push({ ...row });
    }
    return { data: query.returning ? inserted : null, error: null };
  }

  if (query.operation === 'update') {
    const values = query.values as Record<string, unknown>;
    if (Object.keys(values).some((column) => !WRITABLE.includes(column))) {
      return mockPermissionDenied();
    }
    if ('name' in values && mockIsBlank(values.name)) {
      return { data: null, error: { message: 'categories_name_check', code: '23514' } };
    }
    const rows = mockCategories.filter((row) => mockMatches(row, query.filters));
    for (const row of rows) Object.assign(row, values);
    return { data: query.returning ? rows.map((row) => ({ ...row })) : null, error: null };
  }

  const removed = mockCategories.filter((row) => mockMatches(row, query.filters));
  for (const row of removed) mockCategories.splice(mockCategories.indexOf(row), 1);
  return { data: query.returning ? removed : null, error: null };
}

async function mockRun(query: Query, mode: 'many' | 'maybeSingle' | 'single') {
  let result: { data: unknown; error: PostgrestError | null };
  if (query.table === 'profiles') {
    const user = mockAuth.session?.user;
    const role = user ? mockProfiles[user.id] : undefined;
    const rows = user && role ? [{ id: user.id, role, display_name: null }] : [];
    result = { data: rows, error: null };
  } else if (query.table === 'categories') {
    mockCalls.push({ operation: query.operation, values: query.values, filters: query.filters });
    const state = mockServer[query.operation];
    if (state === 'pending') await new Promise<void>((resolve) => mockHeld.push(resolve));
    else if (state !== 'ok') {
      if (query.operation !== 'select') {
        mockWrites.push({
          operation: query.operation,
          values: query.values,
          filters: query.filters,
        });
      }
      return { data: null, error: state.error };
    }
    result = mockApplyCategories(query);
  } else {
    result = { data: [], error: null };
  }

  if (result.error || mode === 'many') return result;
  const rows = (result.data ?? []) as unknown[];
  if (rows.length === 1) return { data: rows[0], error: null };
  if (mode === 'maybeSingle' && rows.length === 0) return { data: null, error: null };
  return {
    data: null,
    error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
  };
}

function mockQueryBuilder(table: string) {
  const query: Query = {
    table,
    operation: 'select',
    filters: [],
    orders: [],
    returning: false,
  };
  const builder = {
    select() {
      if (query.operation !== 'select') query.returning = true;
      return builder;
    },
    insert(values: unknown) {
      query.operation = 'insert';
      query.values = values;
      return builder;
    },
    update(values: unknown) {
      query.operation = 'update';
      query.values = values;
      return builder;
    },
    delete() {
      query.operation = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return builder;
    },
    match(values: Record<string, unknown>) {
      query.filters.push(...Object.entries(values));
      return builder;
    },
    order(column: string, options?: { ascending?: boolean }) {
      query.orders.push([column, options]);
      return builder;
    },
    limit() {
      return builder;
    },
    abortSignal() {
      return builder;
    },
    maybeSingle() {
      return mockRun(query, 'maybeSingle');
    },
    single() {
      return mockRun(query, 'single');
    },
    then<T>(onFulfilled: (value: unknown) => T, onRejected?: (reason: unknown) => T) {
      return mockRun(query, 'many').then(onFulfilled, onRejected);
    },
  };
  return builder;
}

const mockSupabase = {
  auth: {
    getSession: () => Promise.resolve({ data: { session: mockAuth.session }, error: null }),
    getUser: () => Promise.resolve({ data: { user: mockAuth.session?.user ?? null }, error: null }),
    // Re-spec (#122): admin rights need an aal2 session (password and TOTP).
    // The app reads the level and the factors through auth.mfa. Here the
    // admin's session is aal2 with one verified TOTP factor, anyone else's
    // aal1 without a factor; admin-mfa.test.tsx covers the step-up itself.
    mfa: {
      getAuthenticatorAssuranceLevel: () => {
        const level =
          mockAuth.session !== null
            ? mockAuth.session?.user.id === ADMIN.id
              ? 'aal2'
              : 'aal1'
            : null;
        return Promise.resolve({
          data: { currentLevel: level, nextLevel: level, currentAuthenticationMethods: [] },
          error: null,
        });
      },
      listFactors: () => {
        const totp =
          mockAuth.session?.user.id === ADMIN.id
            ? [
                {
                  id: 'f0000000-0000-4000-8000-000000000001',
                  factor_type: 'totp',
                  status: 'verified',
                  friendly_name: '',
                  created_at: '2026-10-01T00:00:00Z',
                  updated_at: '2026-10-01T00:00:00Z',
                },
              ]
            : [];
        return Promise.resolve({ data: { all: totp, totp, phone: [] }, error: null });
      },
    },
    onAuthStateChange: (listener: Listener) => {
      mockAuth.listeners.add(listener);
      void Promise.resolve().then(() => listener('INITIAL_SESSION', mockAuth.session));
      return {
        data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
      };
    },
    signOut: () => {
      mockAuth.session = null;
      for (const listener of mockAuth.listeners) listener('SIGNED_OUT', null);
      return Promise.resolve({ error: null });
    },
  },
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    get auth() {
      return mockSupabase.auth;
    },
    from: (table: string) => mockQueryBuilder(table),
    rpc: () => new Promise(() => {}),
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

function sessionOf(user: User): Session {
  return { access_token: `token-${user.id}`, refresh_token: `refresh-${user.id}`, user };
}

// Lets pending promises, timers and the re-renders they cause settle.
// renderRouter switches Jest to fake timers, so they are run, not waited for.
const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });

async function renderAt(url: string): Promise<{ getPathname(): string }> {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  return { getPathname: () => result.getPathname() };
}

const listTitle = () => text('admin.categories.title');

// The category names on the list, top to bottom.
function listedNames(): string[] {
  return screen.getAllByText(NAMES).map((element) => String(element.props.children));
}

// An action, link, switch or checkbox by its accessible name. The role is
// part of the contract: a screen reader announces what it is.
const ACTION = /^(button|link|switch|checkbox)$/;

function control(name: string) {
  return screen.getByRole(ACTION, { name });
}

async function findControl(name: string) {
  return screen.findByRole(ACTION, { name });
}

// The delete confirmation: a host view with role alertdialog or dialog. Found
// by its role prop rather than getByRole, which only sees `accessible`
// elements: an accessible dialog container would merge its buttons into one
// element for VoiceOver.
function queryDialog(): TestInstance | null {
  const [dialog] = screen.container.queryAll(
    (node) =>
      typeof node.type === 'string' &&
      /^(alertdialog|dialog)$/.test(String(node.props.role ?? node.props.accessibilityRole ?? '')),
  );
  return dialog ?? null;
}

function findDialog(): Promise<TestInstance> {
  return waitFor(() => {
    const dialog = queryDialog();
    if (!dialog) throw new Error('No element with role alertdialog or dialog');
    return dialog;
  });
}

function isChecked(element: TestInstance): boolean | undefined {
  const props = element.props as Record<string, unknown>;
  const state = props.accessibilityState as { checked?: boolean } | undefined;
  return (
    (props['aria-checked'] as boolean | undefined) ?? state?.checked ?? (props.value as boolean)
  );
}

const publishedControl = () =>
  screen.getByRole(/^(switch|checkbox)$/, { name: text('admin.categories.form.published') });

// A Switch takes valueChange, a checkbox-like Pressable a press.
async function setPublished(target: boolean) {
  if (isChecked(publishedControl()) === target) return;
  await fireEvent(publishedControl(), 'valueChange', target);
  if (isChecked(publishedControl()) !== target) await fireEvent.press(publishedControl());
  expect(isChecked(publishedControl())).toBe(target);
}

const nameField = () => screen.getByLabelText(text('admin.categories.form.name'));
const descriptionField = () => screen.getByLabelText(text('admin.categories.form.description'));
const saveButton = () =>
  screen.queryByRole('button', { name: text('admin.categories.form.save') }) ??
  screen.getByRole('button', { name: text('admin.categories.form.saving') });

async function fillForm(values: { name?: string; description?: string; published?: boolean }) {
  await screen.findByLabelText(text('admin.categories.form.name'));
  if (values.name !== undefined) await fireEvent.changeText(nameField(), values.name);
  if (values.description !== undefined) {
    await fireEvent.changeText(descriptionField(), values.description);
  }
  if (values.published !== undefined) await setPublished(values.published);
}

const writesOf = (operation: Operation) => mockWrites.filter((w) => w.operation === operation);

// Reads of the whole list (no id filter) sent after the last `operation`:
// a successful write has to refetch the list from the server rather than
// only patch the cached one.
function listReadsAfterLast(operation: Operation): number {
  const last = mockCalls.map((call) => call.operation).lastIndexOf(operation);
  return mockCalls
    .slice(last + 1)
    .filter((call) => call.operation === 'select' && !call.filters.some(([c]) => c === 'id'))
    .length;
}

beforeEach(async () => {
  mockAuth.session = sessionOf(ADMIN);
  mockAuth.listeners.clear();
  for (const id of Object.keys(mockProfiles)) delete mockProfiles[id];
  mockProfiles[ADMIN.id] = 'admin';
  mockProfiles[LEARNER.id] = 'learner';
  // Out of sort_order on purpose: the screen has to ask for the order.
  mockCategories.length = 0;
  mockCategories.push(
    ...[MUSIK, GESCHICHTE, GEOGRAFIE, NATURWISSENSCHAFTEN].map((row) => ({ ...row })),
  );
  mockServer.select = 'ok';
  mockServer.insert = 'ok';
  mockServer.update = 'ok';
  mockServer.delete = 'ok';
  mockHeld.length = 0;
  mockWrites.length = 0;
  mockCalls.length = 0;
  mockNextId = 1;
  await i18n.changeLanguage('de');
});

describe('category admin texts', () => {
  const keys = [
    'admin.categories.title',
    'admin.categories.loading',
    'admin.categories.empty',
    'admin.categories.error',
    'admin.categories.retry',
    'admin.categories.create',
    'admin.categories.status.published',
    'admin.categories.status.draft',
    'admin.categories.actions.edit',
    'admin.categories.actions.publish',
    'admin.categories.actions.unpublish',
    'admin.categories.actions.delete',
    'admin.categories.errors.toggle',
    'admin.categories.errors.delete',
    'admin.categories.form.createTitle',
    'admin.categories.form.editTitle',
    'admin.categories.form.name',
    'admin.categories.form.description',
    'admin.categories.form.published',
    'admin.categories.form.save',
    'admin.categories.form.saving',
    'admin.categories.form.errors.save',
    'admin.categories.form.errors.nameRequired',
    'admin.categories.form.errors.load',
    'admin.categories.form.notFound',
    'admin.categories.deleteDialog.title',
    'admin.categories.deleteDialog.message',
    'admin.categories.deleteDialog.confirm',
    'admin.categories.deleteDialog.cancel',
  ];

  it.each(keys)('%s has a German and an English text', (key) => {
    expect(text(key, 'de')).toMatch(/\S/);
    expect(text(key, 'en')).toMatch(/\S/);
  });

  it('names the category in each list action, so the actions of different rows differ', () => {
    for (const key of [
      'admin.categories.actions.edit',
      'admin.categories.actions.publish',
      'admin.categories.actions.unpublish',
      'admin.categories.actions.delete',
    ]) {
      expect(label(key, { name: 'Musik' })).toContain('Musik');
      expect(label(key, { name: 'Musik' }, 'en')).toContain('Musik');
    }
  });

  it('warns in the delete dialog that the quizzes go too and the attempts keep their scores', () => {
    const german = label('admin.categories.deleteDialog.message', { name: 'Musik' });
    const english = label('admin.categories.deleteDialog.message', { name: 'Musik' }, 'en');

    expect(german).toMatch(/Quiz/i);
    expect(german).toMatch(/Ergebnis|Punkt/i);
    expect(english).toMatch(/quiz/i);
    expect(english).toMatch(/score|result/i);
  });
});

describe('category list (/admin/categories)', () => {
  it('lists every category by sort_order, unpublished ones included', async () => {
    await renderAt('/admin/categories');

    expect(await screen.findByText('Musik')).toBeOnTheScreen();
    expect(listedNames()).toEqual(['Geografie', 'Naturwissenschaften', 'Geschichte', 'Musik']);
  });

  it('shows the published state of each category', async () => {
    await renderAt('/admin/categories');
    await screen.findByText('Musik');

    expect(screen.getAllByText(text('admin.categories.status.published'))).toHaveLength(3);
    expect(screen.getAllByText(text('admin.categories.status.draft'))).toHaveLength(1);
  });

  it('shows a heading and its texts in English when the language is English', async () => {
    await i18n.changeLanguage('en');

    await renderAt('/admin/categories');

    // #116 re-spec: was `findByText(...)`. The admin header's breadcrumb now
    // repeats this title as its current segment, so the query is scoped to the
    // screen's own heading; it still proves the list shows its heading in English.
    expect(
      await screen.findByRole('heading', { name: text('admin.categories.title', 'en') }),
    ).toBeOnTheScreen();
    expect(await screen.findByText('Musik')).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.categories.status.published', 'en'))).toHaveLength(3);
    expect(screen.getAllByText(text('admin.categories.status.draft', 'en'))).toHaveLength(1);
  });

  it('shows a loading state while the categories are being read', async () => {
    mockServer.select = 'pending';

    await renderAt('/admin/categories');

    expect(await screen.findByText(text('admin.categories.loading'))).toBeOnTheScreen();
    expect(screen.queryByText('Geografie')).toBeNull();
  });

  it('shows an empty state when there are no categories', async () => {
    mockCategories.length = 0;

    await renderAt('/admin/categories');

    expect(await screen.findByText(text('admin.categories.empty'))).toBeOnTheScreen();
    expect(await findControl(text('admin.categories.create'))).toBeOnTheScreen();
  });

  it('shows an error with a retry that loads the categories', async () => {
    mockServer.select = { error: NETWORK_ERROR };

    await renderAt('/admin/categories');

    // Generous: the query client may retry with backoff before it gives up.
    expect(
      await screen.findByText(text('admin.categories.error'), {}, { timeout: 15_000 }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Geografie')).toBeNull();

    mockServer.select = 'ok';
    await fireEvent.press(screen.getByRole('button', { name: text('admin.categories.retry') }));

    expect(await screen.findByText('Geografie')).toBeOnTheScreen();
    expect(screen.queryByText(text('admin.categories.error'))).toBeNull();
  });

  it('keeps a learner out of the category list', async () => {
    mockAuth.session = sessionOf(LEARNER);

    const result = await renderAt('/admin/categories');

    await waitFor(() => {
      const redirected = result.getPathname() === '/admin/sign-in';
      const noAccess = screen.queryByText(text('admin.guard.noAccess')) !== null;
      expect(redirected || noAccess).toBe(true);
    });
    expect(screen.queryByText(listTitle())).toBeNull();
    expect(screen.queryByText('Musik')).toBeNull();
  });

  // Re-spec (#116): was "is reached from the dashboard link". The dashboard
  // is gone; /admin, the admin start, lands on the list.
  it('is reached at /admin, the admin start', async () => {
    const result = await renderAt('/admin');

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(await screen.findByText('Musik')).toBeOnTheScreen();
  });

  it('opens the create form at /admin/categories/new', async () => {
    const result = await renderAt('/admin/categories');

    await fireEvent.press(await findControl(text('admin.categories.create')));

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories/new'));
    // #116 re-spec: was `findByText(...)`. The admin header's breadcrumb now
    // repeats this title as its current segment, so the query is scoped to the
    // screen's own heading; it still proves the create form opened.
    expect(
      await screen.findByRole('heading', { name: text('admin.categories.form.createTitle') }),
    ).toBeOnTheScreen();
  });

  it('opens the edit form of a category at /admin/categories/<id>/edit', async () => {
    const result = await renderAt('/admin/categories');
    await screen.findByText('Musik');

    await fireEvent.press(control(label('admin.categories.actions.edit', { name: 'Musik' })));

    await waitFor(() => expect(result.getPathname()).toBe(`/admin/categories/${MUSIK.id}/edit`));
    // #116 re-spec: was `findByText(...)`. The admin header's breadcrumb now
    // repeats this title as its current segment, so the query is scoped to the
    // screen's own heading; it still proves the edit form opened.
    expect(
      await screen.findByRole('heading', { name: text('admin.categories.form.editTitle') }),
    ).toBeOnTheScreen();
  });
});

describe('create form (/admin/categories/new)', () => {
  it('has labelled fields for name, description and published, unpublished at first', async () => {
    await renderAt('/admin/categories/new');

    expect(await screen.findByLabelText(text('admin.categories.form.name'))).toBeOnTheScreen();
    expect(descriptionField()).toBeOnTheScreen();
    expect(isChecked(publishedControl())).toBeFalsy();
    expect(saveButton()).toBeEnabled();
  });

  it('saves the name, description and published flag, and no sort_order, which the database assigns', async () => {
    await renderAt('/admin/categories/new');

    await fillForm({ name: 'Kunst', description: 'Malerei und Bildhauerei', published: true });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(writesOf('insert')).toHaveLength(1));
    const [insert] = writesOf('insert');
    const values = (Array.isArray(insert.values) ? insert.values[0] : insert.values) as object;
    expect(values).toEqual({
      name: 'Kunst',
      description: 'Malerei und Bildhauerei',
      published: true,
    });
  });

  it('stores an empty description as null', async () => {
    await renderAt('/admin/categories/new');

    await fillForm({ name: 'Kunst', description: '  ' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(writesOf('insert')).toHaveLength(1));
    const [insert] = writesOf('insert');
    const values = (Array.isArray(insert.values) ? insert.values[0] : insert.values) as Record<
      string,
      unknown
    >;
    expect(values.description ?? null).toBeNull();
    expect(values.published ?? false).toBe(false);
  });

  it('returns to the list after saving, where the new category is last and unpublished', async () => {
    const result = await renderAt('/admin/categories');
    await screen.findByText('Musik');
    await fireEvent.press(control(text('admin.categories.create')));

    await fillForm({ name: 'Kunst' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(await screen.findByText('Kunst')).toBeOnTheScreen();
    const names = screen
      .getAllByText(/^(Geografie|Naturwissenschaften|Geschichte|Musik|Kunst)$/)
      .map((element) => String(element.props.children));
    expect(names).toEqual(['Geografie', 'Naturwissenschaften', 'Geschichte', 'Musik', 'Kunst']);
    expect(screen.getAllByText(text('admin.categories.status.draft'))).toHaveLength(2);
  });

  it('rejects a blank name with a translated message and sends nothing', async () => {
    await renderAt('/admin/categories/new');

    await fillForm({ name: ' \t ' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.categories.form.errors.nameRequired')),
    ).toBeOnTheScreen();
    await flush();
    expect(writesOf('insert')).toEqual([]);
  });

  it('shows the blank-name message in English when the language is English', async () => {
    await i18n.changeLanguage('en');
    await renderAt('/admin/categories/new');

    await fillForm({ name: '' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.categories.form.errors.nameRequired', 'en')),
    ).toBeOnTheScreen();
  });

  it('shows a pending state and ignores further presses while saving', async () => {
    mockServer.insert = 'pending';
    const result = await renderAt('/admin/categories/new');
    await fillForm({ name: 'Kunst' });

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.categories.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
    await fireEvent.press(saveButton());
    await flush();
    expect(mockHeld).toHaveLength(1);

    mockServer.insert = 'ok';
    await act(async () => mockRelease());
    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
  });

  it('keeps the input and shows an error when the server fails', async () => {
    mockServer.insert = { error: NETWORK_ERROR };
    const result = await renderAt('/admin/categories/new');
    await fillForm({ name: 'Kunst', description: 'Malerei', published: true });

    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.categories.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe('/admin/categories/new');
    expect(nameField().props.value).toBe('Kunst');
    expect(descriptionField().props.value).toBe('Malerei');
    expect(isChecked(publishedControl())).toBe(true);
    expect(saveButton()).toBeEnabled();
  });
});

describe('edit form (/admin/categories/<id>/edit)', () => {
  it('shows an unpublished category with its values', async () => {
    await renderAt(`/admin/categories/${MUSIK.id}/edit`);

    await waitFor(() => expect(nameField().props.value).toBe('Musik'));
    expect(descriptionField().props.value).toBe('Komponisten und Instrumente');
    expect(isChecked(publishedControl())).toBeFalsy();
  });

  it('saves the changes to that category only, without sort_order', async () => {
    await renderAt(`/admin/categories/${MUSIK.id}/edit`);
    await waitFor(() => expect(nameField().props.value).toBe('Musik'));

    await fillForm({ name: 'Musikgeschichte', description: '', published: true });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(writesOf('update')).toHaveLength(1));
    const [update] = writesOf('update');
    expect(update.filters).toContainEqual(['id', MUSIK.id]);
    expect(Object.keys(update.values as object).every((key) => WRITABLE.includes(key))).toBe(true);
    const stored = mockCategories.find((row) => row.id === MUSIK.id);
    expect(stored).toMatchObject({
      name: 'Musikgeschichte',
      description: null,
      published: true,
      sort_order: 4,
    });
  });

  it('returns to the list after saving, which shows the change', async () => {
    const result = await renderAt('/admin/categories');
    await screen.findByText('Musik');
    await fireEvent.press(control(label('admin.categories.actions.edit', { name: 'Musik' })));
    await waitFor(() => expect(nameField().props.value).toBe('Musik'));

    await fillForm({ name: 'Musikgeschichte' });
    await fireEvent.press(saveButton());

    await waitFor(() => expect(result.getPathname()).toBe('/admin/categories'));
    expect(await screen.findByText('Musikgeschichte')).toBeOnTheScreen();
    expect(screen.queryByText('Musik')).toBeNull();
  });

  it('shows a pending state while saving', async () => {
    mockServer.update = 'pending';
    await renderAt(`/admin/categories/${MUSIK.id}/edit`);
    await waitFor(() => expect(nameField().props.value).toBe('Musik'));

    await fillForm({ name: 'Musikgeschichte' });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.categories.form.saving'))).toBeOnTheScreen();
    expect(saveButton()).toBeDisabled();
  });

  it('keeps the input and shows an error when the server fails', async () => {
    mockServer.update = { error: NETWORK_ERROR };
    const result = await renderAt(`/admin/categories/${MUSIK.id}/edit`);
    await waitFor(() => expect(nameField().props.value).toBe('Musik'));

    await fillForm({ name: 'Musikgeschichte', description: 'Neu', published: true });
    await fireEvent.press(saveButton());

    expect(await screen.findByText(text('admin.categories.form.errors.save'))).toBeOnTheScreen();
    expect(result.getPathname()).toBe(`/admin/categories/${MUSIK.id}/edit`);
    expect(nameField().props.value).toBe('Musikgeschichte');
    expect(descriptionField().props.value).toBe('Neu');
    expect(isChecked(publishedControl())).toBe(true);
  });

  it('rejects a blank name with a translated message and sends nothing', async () => {
    await renderAt(`/admin/categories/${MUSIK.id}/edit`);
    await waitFor(() => expect(nameField().props.value).toBe('Musik'));

    await fillForm({ name: '\n' });
    await fireEvent.press(saveButton());

    expect(
      await screen.findByText(text('admin.categories.form.errors.nameRequired')),
    ).toBeOnTheScreen();
    await flush();
    expect(writesOf('update')).toEqual([]);
  });

  it('shows a not-found state and no form for an unknown category', async () => {
    // e.g. deleted in another tab
    await renderAt('/admin/categories/10000000-0000-4000-8000-0000000000ff/edit');

    expect(await screen.findByText(text('admin.categories.form.notFound'))).toBeOnTheScreen();
    await flush();
    expect(screen.queryByLabelText(text('admin.categories.form.name'))).toBeNull();
    expect(screen.queryByRole('button', { name: text('admin.categories.form.save') })).toBeNull();
    expect(writesOf('update')).toEqual([]);
  });

  it('shows an error with a retry, and no form, when the category cannot be read', async () => {
    mockServer.select = { error: NETWORK_ERROR };
    await renderAt(`/admin/categories/${MUSIK.id}/edit`);

    expect(await screen.findByText(text('admin.categories.form.errors.load'))).toBeOnTheScreen();
    expect(screen.queryByLabelText(text('admin.categories.form.name'))).toBeNull();

    mockServer.select = 'ok';
    await fireEvent.press(control(text('admin.categories.retry')));

    await waitFor(() => expect(nameField().props.value).toBe('Musik'));
    expect(writesOf('update')).toEqual([]);
  });
});

describe('publish toggle on the list', () => {
  it('publishes an unpublished category', async () => {
    await renderAt('/admin/categories');
    await screen.findByText('Musik');

    await fireEvent.press(control(label('admin.categories.actions.publish', { name: 'Musik' })));

    await waitFor(() => expect(writesOf('update')).toHaveLength(1));
    const [update] = writesOf('update');
    expect(update.values).toEqual({ published: true });
    expect(update.filters).toContainEqual(['id', MUSIK.id]);
    expect(
      await findControl(label('admin.categories.actions.unpublish', { name: 'Musik' })),
    ).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.categories.status.published'))).toHaveLength(4);
    expect(screen.queryByText(text('admin.categories.status.draft'))).toBeNull();
  });

  it('reads the list from the server again after publishing', async () => {
    await renderAt('/admin/categories');
    await screen.findByText('Musik');

    await fireEvent.press(control(label('admin.categories.actions.publish', { name: 'Musik' })));

    await waitFor(() => expect(writesOf('update')).toHaveLength(1));
    await waitFor(() => expect(listReadsAfterLast('update')).toBeGreaterThanOrEqual(1));
  });

  it('unpublishes a published category', async () => {
    await renderAt('/admin/categories');
    await screen.findByText('Geografie');

    await fireEvent.press(
      control(label('admin.categories.actions.unpublish', { name: 'Geografie' })),
    );

    await waitFor(() => expect(writesOf('update')).toHaveLength(1));
    expect(writesOf('update')[0].values).toEqual({ published: false });
    expect(writesOf('update')[0].filters).toContainEqual(['id', GEOGRAFIE.id]);
    expect(
      await findControl(label('admin.categories.actions.publish', { name: 'Geografie' })),
    ).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.categories.status.draft'))).toHaveLength(2);
  });

  it('shows an error and keeps the state the server has when publishing fails', async () => {
    mockServer.update = { error: NETWORK_ERROR };
    await renderAt('/admin/categories');
    await screen.findByText('Musik');

    await fireEvent.press(control(label('admin.categories.actions.publish', { name: 'Musik' })));

    expect(await screen.findByText(text('admin.categories.errors.toggle'))).toBeOnTheScreen();
    await flush();
    expect(control(label('admin.categories.actions.publish', { name: 'Musik' }))).toBeOnTheScreen();
    expect(screen.getAllByText(text('admin.categories.status.draft'))).toHaveLength(1);
    expect(mockCategories.find((row) => row.id === MUSIK.id)?.published).toBe(false);
  });
});

describe('delete with confirmation', () => {
  async function openDeleteDialog(name: string) {
    await renderAt('/admin/categories');
    await screen.findByText(name);
    await fireEvent.press(control(label('admin.categories.actions.delete', { name })));
    return findDialog();
  }

  it('asks in a labelled dialog that warns about the quizzes and the scores', async () => {
    const dialog = await openDeleteDialog('Musik');

    expect(dialog).toHaveAccessibleName(
      label('admin.categories.deleteDialog.title', { name: 'Musik' }),
    );
    expect(
      within(dialog).getByText(label('admin.categories.deleteDialog.message', { name: 'Musik' })),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.confirm') }),
    ).toBeOnTheScreen();
    expect(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.cancel') }),
    ).toBeOnTheScreen();
    expect(writesOf('delete')).toEqual([]);
  });

  it('deletes nothing when cancelled', async () => {
    const dialog = await openDeleteDialog('Musik');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.cancel') }),
    );

    await waitFor(() => expect(queryDialog()).toBeNull());
    await flush();
    expect(writesOf('delete')).toEqual([]);
    expect(screen.getByText('Musik')).toBeOnTheScreen();
    expect(mockCategories.some((row) => row.id === MUSIK.id)).toBe(true);
  });

  it('deletes the category when confirmed and removes it from the list', async () => {
    const dialog = await openDeleteDialog('Musik');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(writesOf('delete')).toHaveLength(1));
    expect(writesOf('delete')[0].filters).toContainEqual(['id', MUSIK.id]);
    await waitFor(() => expect(screen.queryByText('Musik')).toBeNull());
    expect(queryDialog()).toBeNull();
    expect(listedNames()).toEqual(['Geografie', 'Naturwissenschaften', 'Geschichte']);
  });

  it('reads the list from the server again after deleting', async () => {
    const dialog = await openDeleteDialog('Musik');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.confirm') }),
    );

    await waitFor(() => expect(writesOf('delete')).toHaveLength(1));
    await waitFor(() => expect(listReadsAfterLast('delete')).toBeGreaterThanOrEqual(1));
  });

  it('shows an error and keeps the category when the delete fails', async () => {
    mockServer.delete = { error: NETWORK_ERROR };
    const dialog = await openDeleteDialog('Musik');

    await fireEvent.press(
      within(dialog).getByRole('button', { name: text('admin.categories.deleteDialog.confirm') }),
    );

    expect(await screen.findByText(text('admin.categories.errors.delete'))).toBeOnTheScreen();
    await flush();
    expect(screen.getByText('Musik')).toBeOnTheScreen();
    expect(listedNames()).toEqual(['Geografie', 'Naturwissenschaften', 'Geschichte', 'Musik']);
  });
});
