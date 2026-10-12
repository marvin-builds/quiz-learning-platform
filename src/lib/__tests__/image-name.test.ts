import * as fc from 'fast-check';

import * as images from '@/lib/images';

// newImageName(mimeType) (#83): the object name an uploaded image gets in the
// quiz-images bucket. The app picks it, never the original file name, so the
// path gives nothing away and can't escape the bucket: a random lowercase
// UUID with the extension of the file's type (image/png .png, image/jpeg
// .jpg, image/webp .webp), at the bucket root. The database and the Storage
// policies accept exactly such names (save_question_images.test.sql,
// storage_quiz_images.test.sql).

// Read through the module's exports, so a missing function fails at run time
// with its name instead of breaking the typecheck.
const { newImageName } = images as unknown as { newImageName: (mimeType: string) => string };

// The rule the database and the Storage policies apply to object names.
const SERVER_RULE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/;

const EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

const mimeType = fc.constantFrom(...(Object.keys(EXTENSION) as (keyof typeof EXTENSION)[]));

describe('newImageName', () => {
  it('names every image with a UUID and its type’s extension at the bucket root, as the server requires', () => {
    fc.assert(
      fc.property(mimeType, (type) => {
        const name = newImageName(type);
        expect(name).toMatch(SERVER_RULE);
        expect(name.endsWith(`.${EXTENSION[type]}`)).toBe(true);
        expect(name).not.toContain('/');
        expect(name).not.toContain('..');
      }),
    );
  });

  it('picks a new random name each time', () => {
    const names = Array.from({ length: 1000 }, (_, index) =>
      newImageName(Object.keys(EXTENSION)[index % 3]),
    );

    expect(new Set(names.map((name) => name.replace(/\.\w+$/, ''))).size).toBe(1000);
  });
});
