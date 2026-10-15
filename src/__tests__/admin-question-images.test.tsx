// First: expo-router/testing-library mocks expo-linking, which must happen
// before expo-router loads it.
import { renderRouter } from 'expo-router/testing-library';

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Images of questions and answers on the admin's question screens (#83),
// rendered through the real route tree in src/app behind the admin guard:
// `/admin/quizzes/<quizId>/questions/new` and
// `/admin/quizzes/<quizId>/questions/<questionId>`.
//
// - Editing shows the stored images of the question and its answers as
//   previews (their public URLs) with their alt texts. The editor reads
//   image_path and image_alt through the columns every role may select
//   (questions and answers); admin_question() and admin_answers() return
//   what they returned before #83.
// - Saving uploads each newly picked file to the quiz-images bucket under
//   the name the form chose (never with upsert, with the file's type), and
//   only then calls save_question with image_path and image_alt for the
//   question and each answer, never the local file.
// - Once the save went through, the objects of replaced or removed images
//   are removed. A failed removal still counts as saved, but (re-spec, #125)
//   the admin is told that the image could not be deleted and is still
//   publicly reachable: a removal fails when the request rejects, when it
//   returns an error, or when its result doesn't list every object it was
//   asked to remove (Storage deletes nothing it may not see and says so only
//   by leaving the object out). The scheduled cleanup removes what stays.
// - If the save fails, the objects uploaded for it are removed again and the
//   stored ones stay; the form keeps the input and explains the failure.
// - If Storage refuses an upload (too large, wrong type, no permission), the
//   form shows a translated message, never Storage's own, and saves nothing.
// - A save that changes no image touches no object.
//
// Boundaries: the Supabase client (network) and the device's picker
// (expo-image-picker). The fake client answers like the local stack does to
// the seed admin: in-memory tables where nobody may select
// questions.explanation or answers.is_correct. The app saves a question and
// its answers in one transaction through save_question, so the fake refuses
// direct table writes (42501) to make a screen that bypasses it fail here,
// although the database grants an admin those writes too. save_question
// keeps the database's image rules (alt text with every image, UUID names at
// the bucket root; else 23514). Storage holds a set of object names;
// `mockServer['storage.upload' | 'storage.remove' | 'rpc.save_question']`
// fails every such request, `mockServer['storage.upload#<n>']` only the
// n-th upload (1-based). `mockRemoval` makes Storage's remove() reject
// ('reject'), delete nothing and list nothing ('nothing', as without a select
// policy) or delete and list only the first object it is given ('first').
// Every request is logged in order in `mockLog`.

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' }),
  ),
}));

const picker = jest.requireMock('expo-image-picker') as { launchImageLibraryAsync: jest.Mock };

// The language the screens currently show.
const shown = (): 'de' | 'en' => (i18n.language === 'en' ? 'en' : 'de');

// Reads a text from de.json or en.json by path (in the language shown), so
// keys that don't exist yet fail at run time with their name instead of
// breaking the typecheck.
function text(key: string): string {
  const lng = shown();
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

// A text with its placeholders filled in through i18next, in the language
// shown, after checking the key exists.
function label(key: string, values: Record<string, string> = {}): string {
  text(key);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng: shown() });
}

type Row = Record<string, unknown> & { id: string };
type Failure = { error: { message: string; code?: string; statusCode?: string; status?: number } };
type Listener = (event: string, session: unknown) => void;

const ADMIN = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'admin@example.com',
  is_anonymous: false,
  user_metadata: {},
  app_metadata: { provider: 'email' },
};
const SESSION = { access_token: 'token-admin', refresh_token: 'refresh-admin', user: ADMIN };

const QUIZ_ID = '20000000-0000-4000-8000-000000000001';
const QUESTION_ID = '30000000-0000-4000-8000-000000000001';
const STORED_PATH = '0a1b2c3d-0000-4000-8000-000000000001.png';
const STORED_ANSWER_PATH = '0a1b2c3d-0000-4000-8000-000000000003.jpg';
const UUID_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/;

const publicUrl = (path: string) =>
  `http://storage.test/storage/v1/object/public/quiz-images/${path}`;

const mockAuth = { listeners: new Set<Listener>() };
const mockTables: Record<'quizzes' | 'questions' | 'answers', Row[]> = {
  quizzes: [],
  questions: [],
  answers: [],
};
const mockObjects = new Set<string>();
const mockServer: Record<string, 'ok' | Failure> = {};
const mockLog: { kind: string; detail: unknown }[] = [];
let mockNextId = 1;
let mockUploadCount = 0;
let mockRemoval: 'normal' | 'reject' | 'nothing' | 'first' = 'normal';

function mockReset() {
  mockAuth.listeners.clear();
  mockTables.quizzes = [
    {
      id: QUIZ_ID,
      category_id: '10000000-0000-4000-8000-000000000001',
      title: 'Tiere',
      description: null,
      published: false,
      sort_order: 1,
    },
  ];
  mockTables.questions = [
    {
      id: QUESTION_ID,
      quiz_id: QUIZ_ID,
      text: 'Welches Tier ist das?',
      explanation: 'Ein Rotfuchs.',
      multiple_correct: false,
      image_path: STORED_PATH,
      image_alt: 'Ein Tier im Gras',
      sort_order: 1,
    },
  ];
  mockTables.answers = [
    {
      id: '40000000-0000-4000-8000-000000000001',
      question_id: QUESTION_ID,
      text: 'Fuchs',
      is_correct: true,
      image_path: STORED_ANSWER_PATH,
      image_alt: 'Ein roter Fuchs',
      sort_order: 1,
    },
    {
      id: '40000000-0000-4000-8000-000000000002',
      question_id: QUESTION_ID,
      text: 'Dachs',
      is_correct: false,
      image_path: null,
      image_alt: null,
      sort_order: 2,
    },
  ];
  mockObjects.clear();
  mockObjects.add(STORED_PATH);
  mockObjects.add(STORED_ANSWER_PATH);
  for (const key of Object.keys(mockServer)) delete mockServer[key];
  mockLog.splice(0);
  mockUploadCount = 0;
  mockRemoval = 'normal';
}

const mockError = (code: string, message: string) => ({ data: null, error: { code, message } });
const mockBlank = (value: unknown) =>
  typeof value !== 'string' || value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') === '';
const mockSolution = (table: string, columns: string) =>
  columns
    .split(',')
    .map((column) => column.trim())
    .some(
      (column) =>
        column === '*' ||
        (table === 'questions' && column === 'explanation') ||
        (table === 'answers' && column === 'is_correct'),
    );

type Query = {
  table: string;
  operation: 'select' | 'insert' | 'update' | 'delete';
  columns: string;
  filters: [string, 'eq' | 'in', unknown][];
};

function mockSelect(query: Query) {
  const table = query.table as keyof typeof mockTables;
  if (query.table === 'profiles') {
    return { data: [{ id: ADMIN.id, role: 'admin', display_name: null }], error: null };
  }
  if (!(table in mockTables)) return { data: [], error: null };
  if (query.operation !== 'select') {
    // Questions and answers are written through save_question only.
    return mockError('42501', `permission denied for table ${table}`);
  }
  if (mockSolution(table, query.columns)) {
    return mockError('42501', `permission denied for table ${table}`);
  }
  const rows = mockTables[table]
    .filter((row) =>
      query.filters.every(([column, op, value]) =>
        op === 'in' ? (value as unknown[]).includes(row[column]) : row[column] === value,
      ),
    )
    .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
    .map((row) => {
      const { explanation: _e, is_correct: _c, ...visible } = row;
      return visible;
    });
  return { data: rows, error: null };
}

function mockBuilder(table: string) {
  const query: Query = { table, operation: 'select', columns: '*', filters: [] };
  const run = (mode: 'many' | 'maybeSingle' | 'single') => {
    mockLog.push({ kind: `${table}.${query.operation}`, detail: query.columns });
    const result = mockSelect(query) as { data: unknown; error: unknown };
    if (result.error || mode === 'many') return Promise.resolve(result);
    const rows = (result.data ?? []) as unknown[];
    if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null });
    if (mode === 'maybeSingle' && rows.length === 0) {
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve(mockError('PGRST116', 'JSON object requested, multiple (or no) rows'));
  };
  const builder = {
    select(columns = '*') {
      if (query.operation === 'select') query.columns = columns;
      return builder;
    },
    insert() {
      query.operation = 'insert';
      return builder;
    },
    update() {
      query.operation = 'update';
      return builder;
    },
    delete() {
      query.operation = 'delete';
      return builder;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, 'eq', value]);
      return builder;
    },
    in(column: string, values: unknown[]) {
      query.filters.push([column, 'in', values]);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    abortSignal() {
      return builder;
    },
    maybeSingle: () => run('maybeSingle'),
    single: () => run('single'),
    then<T>(onFulfilled: (value: unknown) => T, onRejected?: (reason: unknown) => T) {
      return run('many').then(onFulfilled, onRejected);
    },
  };
  return builder;
}

type SentAnswer = {
  id?: string | null;
  text?: unknown;
  is_correct?: unknown;
  image_path?: unknown;
  image_alt?: unknown;
};

// The database's image rule for one image_path / image_alt pair.
function mockImageBreaksRules(path: unknown, alt: unknown) {
  if (path == null) return false;
  return typeof path !== 'string' || !UUID_NAME.test(path) || mockBlank(alt);
}

function mockRpc(fn: string, args: Record<string, unknown> = {}) {
  mockLog.push({ kind: `rpc.${fn}`, detail: args });
  const state = mockServer[`rpc.${fn}`];
  if (state && state !== 'ok') return Promise.resolve({ data: null, error: state.error });
  if (fn === 'admin_question') {
    const question = mockTables.questions.find((row) => row.id === args.question_id);
    return Promise.resolve({
      data: question
        ? [
            {
              id: question.id,
              quiz_id: question.quiz_id,
              text: question.text,
              explanation: question.explanation,
              multiple_correct: question.multiple_correct,
            },
          ]
        : [],
      error: null,
    });
  }
  if (fn === 'admin_answers') {
    return Promise.resolve({
      data: mockTables.answers
        .filter((row) => row.question_id === args.question_id)
        .map(({ id, text: answerText, is_correct, sort_order }) => ({
          id,
          text: answerText,
          is_correct,
          sort_order,
        })),
      error: null,
    });
  }
  if (fn === 'save_question') {
    const answers = (Array.isArray(args.answers) ? args.answers : []) as SentAnswer[];
    if (
      mockImageBreaksRules(args.image_path, args.image_alt) ||
      answers.some((answer) => mockImageBreaksRules(answer.image_path, answer.image_alt))
    ) {
      return Promise.resolve(mockError('23514', 'image_rules'));
    }
    const fields = {
      text: args.text,
      explanation: args.explanation ?? null,
      multiple_correct: args.multiple_correct === true,
      image_path: args.image_path ?? null,
      image_alt: args.image_path == null ? null : args.image_alt,
    };
    let id = args.question_id as string | null | undefined;
    if (id == null) {
      id = `90000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`;
      mockTables.questions.push({ id, quiz_id: args.quiz_id, sort_order: 99, ...fields });
    } else {
      Object.assign(mockTables.questions.find((row) => row.id === id) ?? {}, fields);
    }
    const questionId = id;
    mockTables.answers = mockTables.answers.filter((row) => row.question_id !== questionId);
    answers.forEach((answer, index) =>
      mockTables.answers.push({
        id: answer.id ?? `91000000-0000-4000-8000-${String(mockNextId++).padStart(12, '0')}`,
        question_id: questionId,
        text: answer.text,
        is_correct: answer.is_correct === true,
        image_path: answer.image_path ?? null,
        image_alt: answer.image_path == null ? null : answer.image_alt,
        sort_order: index + 1,
      }),
    );
    return Promise.resolve({ data: questionId, error: null });
  }
  return Promise.resolve(mockError('PGRST202', `Could not find the function public.${fn}`));
}

const mockStorage = {
  from: (bucket: string) => ({
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `http://storage.test/storage/v1/object/public/${bucket}/${path}` },
    }),
    upload: (path: string, _body: unknown, options?: Record<string, unknown>) => {
      mockLog.push({ kind: 'storage.upload', detail: { bucket, path, options } });
      mockUploadCount += 1;
      const state = mockServer[`storage.upload#${mockUploadCount}`] ?? mockServer['storage.upload'];
      if (state && state !== 'ok') return Promise.resolve({ data: null, error: state.error });
      if (mockObjects.has(path) && options?.upsert !== true) {
        return Promise.resolve({
          data: null,
          error: { message: 'The resource already exists', statusCode: '409' },
        });
      }
      mockObjects.add(path);
      return Promise.resolve({ data: { path, fullPath: `${bucket}/${path}` }, error: null });
    },
    remove: (paths: string[]) => {
      mockLog.push({ kind: 'storage.remove', detail: { bucket, paths } });
      const state = mockServer['storage.remove'];
      if (state && state !== 'ok') return Promise.resolve({ data: null, error: state.error });
      if (mockRemoval === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      if (mockRemoval === 'nothing') return Promise.resolve({ data: [], error: null });
      const removed = (mockRemoval === 'first' ? paths.slice(0, 1) : paths).filter((path) =>
        mockObjects.delete(path),
      );
      return Promise.resolve({ data: removed.map((name) => ({ name })), error: null });
    },
  }),
};

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
      getUser: () => Promise.resolve({ data: { user: ADMIN }, error: null }),
      onAuthStateChange: (listener: Listener) => {
        mockAuth.listeners.add(listener);
        void Promise.resolve().then(() => listener('INITIAL_SESSION', SESSION));
        return {
          data: { subscription: { unsubscribe: () => mockAuth.listeners.delete(listener) } },
        };
      },
      signOut: () => Promise.resolve({ error: null }),
    },
    from: (table: string) => mockBuilder(table),
    rpc: (fn: string, args?: Record<string, unknown>) => mockRpc(fn, args),
    get storage() {
      return mockStorage;
    },
  },
}));

// The root layout imports the NativeWind stylesheet, which Jest can't load.
jest.mock('../../global.css', () => ({}));

// Reading a picked file (a local URI) is I/O at the boundary: any URI reads
// as a few bytes.
const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
    blob: async () => new Blob([new Uint8Array(8)], { type: 'image/png' }),
  })) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  mockReset();
  picker.launchImageLibraryAsync.mockReset();
});

const flush = () =>
  act(async () => {
    await jest.runOnlyPendingTimersAsync();
  });

async function renderAt(url: string) {
  const result = renderRouter('src/app', { initialUrl: url });
  await result;
  await flush();
  return { getPathname: () => result.getPathname() };
}

const editUrl = `/admin/quizzes/${QUIZ_ID}/questions/${QUESTION_ID}`;
const newUrl = `/admin/quizzes/${QUIZ_ID}/questions/new`;
const listUrl = `/admin/quizzes/${QUIZ_ID}`;

const button = (name: string) => screen.findByRole('button', { name });
const field = (name: string) => screen.findByLabelText(name);

function sourceUri(image: TestInstance): string | undefined {
  const source = image.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

function picks(asset: { uri: string; mimeType: string; fileSize: number; fileName: string }) {
  picker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ width: 640, height: 480, type: 'image', ...asset }],
  });
}

const BADGER = {
  uri: 'file:///picked/Dachs%20im%20Wald.webp',
  mimeType: 'image/webp',
  fileSize: 4096,
  fileName: 'Dachs im Wald.webp',
};

const logOf = (kind: string) => mockLog.filter((entry) => entry.kind === kind);
const position = (kind: string) => mockLog.findIndex((entry) => entry.kind === kind);
const uploads = () =>
  logOf('storage.upload').map(
    (entry) => entry.detail as { bucket: string; path: string; options?: Record<string, unknown> },
  );
const removals = () =>
  logOf('storage.remove').map((entry) => entry.detail as { bucket: string; paths: string[] });
const removedPaths = () => removals().flatMap((removal) => removal.paths);
const saveArgs = () =>
  logOf('rpc.save_question').map((entry) => entry.detail as Record<string, unknown>);

async function save() {
  await fireEvent.press(await button(label('admin.questions.form.save')));
  await flush();
}

async function replaceQuestionImage() {
  picks(BADGER);
  await fireEvent.press(await button(label('admin.questions.form.image.replace')));
  await flush();
}

const FOX = {
  uri: 'file:///picked/Fuchs%20im%20Schnee.png',
  mimeType: 'image/png',
  fileSize: 2048,
  fileName: 'Fuchs im Schnee.png',
};

async function replaceFirstAnswerImage() {
  picks(FOX);
  await fireEvent.press(
    await button(label('admin.questions.form.answers.image.replace', { number: '1' })),
  );
  await flush();
}

describe('admin question screens: images', () => {
  it('shows the stored images of a question and its answers with their alt texts when editing', async () => {
    await renderAt(editUrl);

    const preview = await screen.findByRole('image', {
      name: label('admin.questions.form.image.preview'),
    });
    expect(sourceUri(preview)).toBe(publicUrl(STORED_PATH));
    expect(await field(label('admin.questions.form.image.alt'))).toHaveDisplayValue(
      'Ein Tier im Gras',
    );

    const answerPreview = await screen.findByRole('image', {
      name: label('admin.questions.form.answers.image.preview', { number: '1' }),
    });
    expect(sourceUri(answerPreview)).toBe(publicUrl(STORED_ANSWER_PATH));
    expect(
      await field(label('admin.questions.form.answers.image.alt', { number: '1' })),
    ).toHaveDisplayValue('Ein roter Fuchs');
    expect(
      screen.queryByRole('image', {
        name: label('admin.questions.form.answers.image.preview', { number: '2' }),
      }),
    ).toBeNull();
  });

  it('uploads a picked image under its new name before saving, then saves the question with it', async () => {
    const result = await renderAt(newUrl);
    await fireEvent.changeText(await field(label('admin.questions.form.text')), 'Wer wohnt hier?');
    await fireEvent.changeText(
      await field(label('admin.questions.form.answers.text', { number: '1' })),
      'Dachs',
    );
    await fireEvent.changeText(
      await field(label('admin.questions.form.answers.text', { number: '2' })),
      'Igel',
    );
    await fireEvent.press(
      await screen.findByRole('checkbox', {
        name: label('admin.questions.form.answers.correct', { number: '1' }),
      }),
    );
    picks(BADGER);
    await fireEvent.press(await button(label('admin.questions.form.image.pick')));
    await flush();
    await fireEvent.changeText(
      await field(label('admin.questions.form.image.alt')),
      'Ein Dachs vor seinem Bau',
    );

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    expect(uploads()).toHaveLength(1);
    const [upload] = uploads();
    expect(upload.bucket).toBe('quiz-images');
    expect(upload.path).toMatch(UUID_NAME);
    expect(upload.path.endsWith('.webp')).toBe(true);
    expect(upload.path).not.toMatch(/dachs/i);
    expect(upload.options?.contentType).toBe('image/webp');
    expect(upload.options?.upsert).not.toBe(true);
    expect(position('storage.upload')).toBeLessThan(position('rpc.save_question'));

    expect(saveArgs()).toHaveLength(1);
    const [args] = saveArgs();
    expect(args).toMatchObject({ image_path: upload.path, image_alt: 'Ein Dachs vor seinem Bau' });
    expect(Object.keys(args)).not.toContain('image_file');
    for (const answer of args.answers as Record<string, unknown>[]) {
      expect(Object.keys(answer)).not.toContain('image_file');
      expect(answer.image_path ?? null).toBeNull();
    }
    expect(mockObjects.has(upload.path)).toBe(true);
    expect(removals()).toEqual([]);
  });

  it('removes the replaced object once the save went through, not before', async () => {
    const result = await renderAt(editUrl);
    await replaceQuestionImage();

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    const [upload] = uploads();
    expect(saveArgs()[0]).toMatchObject({ image_path: upload.path, image_alt: 'Ein Tier im Gras' });
    expect(removedPaths()).toEqual([STORED_PATH]);
    expect(position('storage.remove')).toBeGreaterThan(position('rpc.save_question'));
    expect(mockObjects.has(STORED_PATH)).toBe(false);
    expect(mockObjects.has(upload.path)).toBe(true);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(true);
  });

  it('saves a removed question image as none and removes its object after the save', async () => {
    const result = await renderAt(editUrl);
    await fireEvent.press(await button(label('admin.questions.form.image.remove')));

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    expect(uploads()).toEqual([]);
    expect(saveArgs()[0].image_path ?? null).toBeNull();
    expect(removedPaths()).toEqual([STORED_PATH]);
    expect(position('storage.remove')).toBeGreaterThan(position('rpc.save_question'));
    expect(mockObjects.has(STORED_PATH)).toBe(false);
  });

  it('saves a removed answer image as none and removes its object after the save', async () => {
    const result = await renderAt(editUrl);
    await fireEvent.press(
      await button(label('admin.questions.form.answers.image.remove', { number: '1' })),
    );

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    const [args] = saveArgs();
    expect((args.answers as SentAnswer[])[0].image_path ?? null).toBeNull();
    expect(args.image_path).toBe(STORED_PATH);
    expect(removedPaths()).toEqual([STORED_ANSWER_PATH]);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(false);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
  });

  it('uploads a replaced answer image before saving, sends it with that answer, and removes the old object after the save', async () => {
    const result = await renderAt(editUrl);
    await replaceFirstAnswerImage();
    await fireEvent.changeText(
      await field(label('admin.questions.form.answers.image.alt', { number: '1' })),
      'Ein Fuchs im Schnee',
    );

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    expect(uploads()).toHaveLength(1);
    const [upload] = uploads();
    expect(upload.bucket).toBe('quiz-images');
    expect(upload.path).toMatch(UUID_NAME);
    expect(upload.path.endsWith('.png')).toBe(true);
    expect(upload.path).not.toBe(STORED_ANSWER_PATH);
    expect(upload.options?.contentType).toBe('image/png');
    expect(upload.options?.upsert).not.toBe(true);
    expect(position('storage.upload')).toBeLessThan(position('rpc.save_question'));

    const [args] = saveArgs();
    const [first, second] = args.answers as SentAnswer[];
    expect(first).toMatchObject({ image_path: upload.path, image_alt: 'Ein Fuchs im Schnee' });
    expect(Object.keys(first)).not.toContain('image_file');
    expect(second.image_path ?? null).toBeNull();
    expect(args).toMatchObject({ image_path: STORED_PATH, image_alt: 'Ein Tier im Gras' });

    expect(removedPaths()).toEqual([STORED_ANSWER_PATH]);
    expect(position('storage.remove')).toBeGreaterThan(position('rpc.save_question'));
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(false);
    expect(mockObjects.has(upload.path)).toBe(true);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
  });

  it('removes the image it already uploaded when a later upload of the same save is refused, and saves nothing', async () => {
    mockServer['storage.upload#2'] = {
      error: {
        message: 'The object exceeded the maximum allowed size',
        statusCode: '413',
        status: 400,
      },
    };
    const result = await renderAt(editUrl);
    await replaceQuestionImage();
    await replaceFirstAnswerImage();

    await save();

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageUpload')),
    ).toBeOnTheScreen();
    expect(uploads()).toHaveLength(2);
    const [firstUpload, refusedUpload] = uploads();
    await waitFor(() => expect(removedPaths()).toContain(firstUpload.path));
    expect(mockObjects.has(firstUpload.path)).toBe(false);
    expect(mockObjects.has(refusedUpload.path)).toBe(false);
    expect(saveArgs()).toEqual([]);
    expect(removedPaths()).not.toContain(STORED_PATH);
    expect(removedPaths()).not.toContain(STORED_ANSWER_PATH);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(true);
    expect(result.getPathname()).toBe(editUrl);
  });

  it('removes the object it just uploaded when the database refuses the save, keeps the stored one, and keeps the input', async () => {
    // Re-spec (#83, R2): this was a transport error ('TypeError: Failed to
    // fetch', no code), where the save may have committed and the row may
    // name the new object, so removing it could break the image. A database
    // refusal that isn't a rule refusal (here 42501) rolled the save back, so
    // the just-uploaded object is an orphan and goes.
    mockServer['rpc.save_question'] = {
      error: { message: 'permission denied for function save_question', code: '42501' },
    };
    const result = await renderAt(editUrl);
    await replaceQuestionImage();
    await fireEvent.changeText(await field(label('admin.questions.form.image.alt')), 'Ein Dachs');

    await save();

    expect(await screen.findByText(label('admin.questions.form.errors.save'))).toBeOnTheScreen();
    const [upload] = uploads();
    await waitFor(() => expect(removedPaths()).toEqual([upload.path]));
    expect(mockObjects.has(upload.path)).toBe(false);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
    expect(result.getPathname()).toBe(editUrl);
    expect(await field(label('admin.questions.form.image.alt'))).toHaveDisplayValue('Ein Dachs');
  });

  it('keeps every object when the save fails in transport, since it may have gone through, and keeps the input', async () => {
    // Re-spec (#83, R2): with no answer from the database the save may have
    // committed and the row may name the new object. Removing it could break
    // the image, so nothing is removed (worst case an orphan).
    mockServer['rpc.save_question'] = {
      error: { message: 'TypeError: Failed to fetch', code: '' },
    };
    const result = await renderAt(editUrl);
    await replaceQuestionImage();
    await fireEvent.changeText(await field(label('admin.questions.form.image.alt')), 'Ein Dachs');

    await save();

    expect(await screen.findByText(label('admin.questions.form.errors.save'))).toBeOnTheScreen();
    // Give a late clean-up every chance to run before asserting it didn't.
    await flush();
    await flush();
    expect(uploads()).toHaveLength(1);
    expect(saveArgs()).toHaveLength(1);
    const [upload] = uploads();
    expect(removedPaths()).toEqual([]);
    expect(mockObjects.has(upload.path)).toBe(true);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(true);
    expect(result.getPathname()).toBe(editUrl);
    expect(await field(label('admin.questions.form.image.alt'))).toHaveDisplayValue('Ein Dachs');
  });

  it('explains a refusal of the database’s image rules after the upload and removes the object it just uploaded', async () => {
    // The form's own checks pass; the database still refuses (23514), e.g. a
    // rule the client doesn't mirror. Like any rule refusal of save_question,
    // it is explained with the translated rules text, never the raw message.
    mockServer['rpc.save_question'] = { error: { code: '23514', message: 'image_rules' } };
    const result = await renderAt(editUrl);
    await replaceQuestionImage();
    await fireEvent.changeText(await field(label('admin.questions.form.image.alt')), 'Ein Dachs');

    await save();

    expect(await screen.findByText(label('admin.questions.form.errors.rules'))).toBeOnTheScreen();
    expect(screen.queryByText('image_rules', { exact: false })).toBeNull();
    expect(uploads()).toHaveLength(1);
    const [upload] = uploads();
    expect(position('storage.upload')).toBeLessThan(position('rpc.save_question'));
    await waitFor(() => expect(removedPaths()).toEqual([upload.path]));
    expect(position('storage.remove')).toBeGreaterThan(position('rpc.save_question'));
    expect(mockObjects.has(upload.path)).toBe(false);
    expect(mockObjects.has(STORED_PATH)).toBe(true);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(true);
    expect(result.getPathname()).toBe(editUrl);
    expect(await field(label('admin.questions.form.image.alt'))).toHaveDisplayValue('Ein Dachs');
  });

  it.each([
    ['too large', { message: 'The object exceeded the maximum allowed size', statusCode: '413' }],
    [
      'of a type the bucket refuses',
      { message: 'mime type image/webp is not supported', statusCode: '415' },
    ],
    [
      'without permission',
      { message: 'new row violates row-level security policy', statusCode: '403' },
    ],
  ])(
    'explains a refused upload (%s) in its own words, never Storage’s, and saves nothing',
    async (_case, error) => {
      mockServer['storage.upload'] = { error: { ...error, status: 400 } };
      const result = await renderAt(editUrl);
      await replaceQuestionImage();

      await save();

      expect(
        await screen.findByText(label('admin.questions.form.errors.imageUpload')),
      ).toBeOnTheScreen();
      expect(screen.queryByText(error.message, { exact: false })).toBeNull();
      expect(saveArgs()).toEqual([]);
      expect(removedPaths()).not.toContain(STORED_PATH);
      expect(mockObjects.has(STORED_PATH)).toBe(true);
      expect(result.getPathname()).toBe(editUrl);
    },
  );

  it('counts the save as done when removing the old object afterwards fails', async () => {
    mockServer['storage.remove'] = {
      error: { message: 'Internal Server Error', statusCode: '500' },
    };
    const result = await renderAt(editUrl);
    await replaceQuestionImage();

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    expect(saveArgs()).toHaveLength(1);
    expect(screen.queryByText(label('admin.questions.form.errors.save'))).toBeNull();
  });

  it('touches no object when a save changes no image', async () => {
    const result = await renderAt(editUrl);
    await fireEvent.changeText(
      await field(label('admin.questions.form.text')),
      'Welches Tier sieht man hier?',
    );

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    expect(uploads()).toEqual([]);
    expect(removals()).toEqual([]);
    expect(saveArgs()[0]).toMatchObject({ image_path: STORED_PATH, image_alt: 'Ein Tier im Gras' });
    expect((saveArgs()[0].answers as SentAnswer[])[0]).toMatchObject({
      image_path: STORED_ANSWER_PATH,
      image_alt: 'Ein roter Fuchs',
    });
  });
});

// #125: a removal that fails leaves the image publicly reachable, so the admin
// is told, in the app's own words, never Storage's. The save itself still
// counts as done (see 'counts the save as done when removing the old object
// afterwards fails' above), so after a save that went through the notice
// shows on the question list the editor returns to.
describe('admin question screens: a failed image removal (#125)', () => {
  const NOTICE = 'admin.questions.errors.imageRemove';

  // Each way a removal can fail, and what the fake does for it.
  const failures: [string, () => void][] = [
    [
      'returns an error',
      () => {
        mockServer['storage.remove'] = {
          error: { message: 'Internal Server Error', statusCode: '500' },
        };
      },
    ],
    [
      'rejects',
      () => {
        mockRemoval = 'reject';
      },
    ],
    [
      'deletes nothing',
      () => {
        mockRemoval = 'nothing';
      },
    ],
    [
      'deletes only some of the objects',
      () => {
        mockRemoval = 'first';
      },
    ],
  ];

  async function replaceBothImages() {
    await replaceQuestionImage();
    await replaceFirstAnswerImage();
  }

  it('has the notice in German and English', () => {
    for (const lng of ['de', 'en'] as const) {
      const value = NOTICE.split('.').reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        lng === 'de' ? de : en,
      );
      expect(typeof value).toBe('string');
      expect((value as string).trim()).not.toBe('');
    }
  });

  it.each(failures)(
    'tells the admin on the question list that an old image is still online when its removal after the save %s',
    async (_case, fail) => {
      fail();
      const result = await renderAt(editUrl);
      await replaceBothImages();

      await save();

      await waitFor(() => expect(result.getPathname()).toBe(listUrl));
      expect(saveArgs()).toHaveLength(1);
      expect(removedPaths()).toEqual(expect.arrayContaining([STORED_PATH, STORED_ANSWER_PATH]));
      expect(await screen.findByText(label(NOTICE))).toBeOnTheScreen();
      expect(screen.queryByText(label('admin.questions.form.errors.save'))).toBeNull();
      expect(screen.queryByText('Internal Server Error', { exact: false })).toBeNull();
      expect(screen.queryByText('Failed to fetch', { exact: false })).toBeNull();
    },
  );

  it('shows no such notice when the old images were removed', async () => {
    const result = await renderAt(editUrl);
    await replaceBothImages();

    await save();

    await waitFor(() => expect(result.getPathname()).toBe(listUrl));
    await waitFor(() => expect(removedPaths()).toEqual([STORED_PATH, STORED_ANSWER_PATH]));
    await flush();
    expect(mockObjects.has(STORED_PATH)).toBe(false);
    expect(mockObjects.has(STORED_ANSWER_PATH)).toBe(false);
    expect(screen.queryByText(label(NOTICE))).toBeNull();
  });

  it.each(failures)(
    'tells the admin that the images it just uploaded are still online when the database refused the save and their removal %s',
    async (_case, fail) => {
      fail();
      mockServer['rpc.save_question'] = {
        error: { message: 'permission denied for function save_question', code: '42501' },
      };
      const result = await renderAt(editUrl);
      await replaceBothImages();

      await save();

      expect(await screen.findByText(label('admin.questions.form.errors.save'))).toBeOnTheScreen();
      const uploaded = uploads().map((upload) => upload.path);
      expect(uploaded).toHaveLength(2);
      await waitFor(() => expect(removedPaths()).toEqual(expect.arrayContaining(uploaded)));
      expect(await screen.findByText(label(NOTICE))).toBeOnTheScreen();
      expect(screen.queryByText('Internal Server Error', { exact: false })).toBeNull();
      expect(screen.queryByText('Failed to fetch', { exact: false })).toBeNull();
      expect(result.getPathname()).toBe(editUrl);
    },
  );

  // A refused second upload leaves one uploaded object to remove, and 'first'
  // removes a single object fully, so that mode is no failure here.
  it.each(failures.filter(([name]) => name !== 'deletes only some of the objects'))(
    'tells the admin that the image it already uploaded is still online when a later upload is refused and its removal %s',
    async (_case, fail) => {
      fail();
      mockServer['storage.upload#2'] = {
        error: {
          message: 'The object exceeded the maximum allowed size',
          statusCode: '413',
          status: 400,
        },
      };
      const result = await renderAt(editUrl);
      await replaceBothImages();

      await save();

      expect(
        await screen.findByText(label('admin.questions.form.errors.imageUpload')),
      ).toBeOnTheScreen();
      expect(uploads()).toHaveLength(2);
      const [firstUpload] = uploads();
      await waitFor(() => expect(removedPaths()).toContain(firstUpload.path));
      expect(saveArgs()).toEqual([]);
      expect(await screen.findByText(label(NOTICE))).toBeOnTheScreen();
      expect(screen.queryByText('Internal Server Error', { exact: false })).toBeNull();
      expect(screen.queryByText('Failed to fetch', { exact: false })).toBeNull();
      expect(screen.queryByText('maximum allowed size', { exact: false })).toBeNull();
      expect(result.getPathname()).toBe(editUrl);
    },
  );

  it('shows no such notice when the database refused the save and the images it just uploaded were removed', async () => {
    mockServer['rpc.save_question'] = {
      error: { message: 'permission denied for function save_question', code: '42501' },
    };
    await renderAt(editUrl);
    await replaceBothImages();

    await save();

    expect(await screen.findByText(label('admin.questions.form.errors.save'))).toBeOnTheScreen();
    const uploaded = uploads().map((upload) => upload.path);
    await waitFor(() => expect(removedPaths()).toEqual(uploaded));
    await flush();
    expect(uploaded.some((path) => mockObjects.has(path))).toBe(false);
    expect(screen.queryByText(label(NOTICE))).toBeNull();
  });
});
