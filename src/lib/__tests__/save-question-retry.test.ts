import { saveQuestion } from '@/lib/admin-questions';
import type { QuestionWithAnswersValues } from '@/lib/question-schema';

// A save that fails, and whose clean-up remove fails too, leaves the object
// it uploaded in the bucket. Storage never overwrites (upsert: false), so a
// retry that uploads under the same name is refused for good. Every save
// attempt therefore uploads under a fresh name (#83, review).

const mockObjects = new Set<string>();
const mockUploads: string[] = [];
const mockSaves: Record<string, unknown>[] = [];
const mockState = { saveError: null as unknown, removeFails: false };

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (_name: string, args: Record<string, unknown>) => {
      mockSaves.push(args);
      return Promise.resolve({ data: null, error: mockState.saveError });
    },
    storage: {
      from: () => ({
        upload: (path: string) => {
          mockUploads.push(path);
          if (mockObjects.has(path)) {
            return Promise.resolve({
              data: null,
              error: { message: 'The resource already exists', statusCode: '409' },
            });
          }
          mockObjects.add(path);
          return Promise.resolve({ data: { path }, error: null });
        },
        remove: (paths: string[]) => {
          if (mockState.removeFails) return Promise.reject(new Error('Failed to fetch'));
          paths.forEach((path) => mockObjects.delete(path));
          return Promise.resolve({ data: [], error: null });
        },
      }),
    },
  },
}));

const QUIZ_ID = '10000000-0000-4000-8000-000000000001';
const PICKED_NAME = '20000000-0000-4000-8000-000000000002.png';
const UUID_PNG = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;

const values = {
  text: 'Welches Tier ist das?',
  type: 'single',
  explanation: null,
  image_path: PICKED_NAME,
  image_alt: 'Ein Fuchs',
  image_file: { uri: 'file:///picked/fuchs.png', mimeType: 'image/png', size: 2048 },
  answers: [
    { text: 'Fuchs', is_correct: true, image_path: null, image_alt: null, image_file: null },
    { text: 'Dachs', is_correct: false, image_path: null, image_alt: null, image_file: null },
  ],
} as unknown as QuestionWithAnswersValues;

const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
  ) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = realFetch;
});

it('uploads under a fresh name on a retry after a failed save left its object behind', async () => {
  mockState.saveError = { message: 'TypeError: Failed to fetch', code: '' };
  mockState.removeFails = true;
  await expect(saveQuestion(QUIZ_ID, null, values)).rejects.toBeDefined();
  expect(mockObjects.size).toBe(1);

  mockState.saveError = null;
  mockState.removeFails = false;
  await expect(saveQuestion(QUIZ_ID, null, values)).resolves.toBeUndefined();

  expect(mockUploads).toHaveLength(2);
  expect(mockUploads[1]).not.toBe(mockUploads[0]);
  expect(mockUploads[1]).toMatch(UUID_PNG);
  // The row names the object this attempt uploaded.
  expect(mockSaves[1]).toMatchObject({ image_path: mockUploads[1] });
});
