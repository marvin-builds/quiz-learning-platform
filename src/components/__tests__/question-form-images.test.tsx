import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import type { TestInstance } from 'test-renderer';

import { QuestionForm } from '@/components/question-form';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';

// The images of the question form (#83): the question and each answer can
// have an image, picked from the device's library (expo-image-picker; the
// web build uses a file input of its own, covered by the e2e test),
// previewed, replaced and removed, always with an alt text.
//
// - A picked file is checked at once against the bucket's limits (at most
//   5 MiB, png/jpeg/webp); a refused one shows a translated message and is
//   never submitted.
// - A taken file gets a new object name chosen by the app (a UUID with its
//   type's extension, never the original file name) as image_path; onSubmit
//   gets it with image_alt and image_file ({ uri, mimeType, size }) to upload.
// - Saving with an image but no alt text is refused with a translated
//   message (the database's check, mirrored in the schema).
// - Editing shows a stored image as a preview (its public URL) with its alt
//   text; saved unchanged it keeps its image_path and has no image_file.
// - expo-image-picker (SDK 57) may leave an asset's mimeType or fileSize
//   undefined. An unknown type is taken from the file name's or URI's
//   extension (png, jpg/jpeg, webp) and refused like any other type when
//   there is none of those. An unknown size is taken; the bucket's own 5 MiB
//   limit refuses a larger file at upload (admin-question-images.test.tsx).
//
// Boundaries: the device's picker (expo-image-picker) and the Storage
// client's public URL. Texts come from de.json, so a missing key fails with
// its name.

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, status: 'granted', canAskAgain: true, expires: 'never' }),
  ),
}));

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(() => new Promise(() => {})),
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `http://storage.test/storage/v1/object/public/${bucket}/${path}` },
        }),
      }),
    },
  },
}));

const picker = jest.requireMock('expo-image-picker') as {
  launchImageLibraryAsync: jest.Mock;
};

const publicUrl = (path: string) =>
  `http://storage.test/storage/v1/object/public/quiz-images/${path}`;

// Reads a text from de.json by path, so keys that don't exist yet fail at run
// time with their name instead of breaking the typecheck.
function text(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], de);
  if (typeof value !== 'string') throw new Error(`de.json has no text for ${key}`);
  return value;
}

// A text with its placeholders filled in through i18next, after checking
// the key exists.
function label(key: string, values: Record<string, string> = {}): string {
  text(key);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng: 'de' });
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
const MiB5 = 5242880;

type Asset = { uri: string; mimeType: string; fileSize: number; fileName: string };

const FOX: Asset = {
  uri: 'file:///picked/Mein%20Fuchs.png',
  mimeType: 'image/png',
  fileSize: 2048,
  fileName: 'Mein Fuchs.png',
};
const BADGER: Asset = {
  uri: 'file:///picked/dachs.webp',
  mimeType: 'image/webp',
  fileSize: 4096,
  fileName: 'dachs.webp',
};

function picks(asset: Asset) {
  picker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ width: 640, height: 480, type: 'image', ...asset }],
  });
}

// An asset as the picker may return it on a device: mimeType, fileSize or
// fileName missing.
function picksPartly(asset: Partial<Asset> & { uri: string }) {
  picker.launchImageLibraryAsync.mockResolvedValueOnce({
    canceled: false,
    assets: [{ width: 640, height: 480, type: 'image', ...asset }],
  });
}

type Submitted = {
  image_path: string | null;
  image_alt: string | null;
  image_file: { uri: string; mimeType: string; size: number } | null;
  answers: {
    image_path: string | null;
    image_alt: string | null;
    image_file: { uri: string; mimeType: string; size: number } | null;
  }[];
};

// What a form's onSubmit received, as this test reads it.
const submitted = (onSubmit: jest.Mock): Submitted[] =>
  onSubmit.mock.calls.map(([values]) => values as Submitted);

type Initial = ComponentProps<typeof QuestionForm>['initial'];

// A stored question with an image, and an answer with one.
const STORED_PATH = '0a1b2c3d-0000-4000-8000-000000000001.png';
const STORED_ANSWER_PATH = '0a1b2c3d-0000-4000-8000-000000000003.jpg';
const STORED = {
  text: 'Welches Tier ist das?',
  explanation: null,
  multiple_correct: false,
  image_path: STORED_PATH,
  image_alt: 'Ein Tier im Gras',
  answers: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      text: 'Fuchs',
      is_correct: true,
      image_path: STORED_ANSWER_PATH,
      image_alt: 'Ein roter Fuchs',
    },
    {
      id: '40000000-0000-4000-8000-000000000002',
      text: 'Dachs',
      is_correct: false,
      image_path: null,
      image_alt: null,
    },
  ],
} as unknown as Initial;

async function renderForm(initial?: Initial) {
  const onSubmit = jest.fn();
  await render(
    <QuestionForm initial={initial} pending={false} failure={null} onSubmit={onSubmit} />,
  );
  return onSubmit;
}

const button = (name: string) => screen.getByRole('button', { name });
const field = (name: string) => screen.getByLabelText(name);

function sourceUri(image: TestInstance): string | undefined {
  const source = image.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

const questionPreview = () =>
  screen.queryByRole('image', { name: label('admin.questions.form.image.preview') });
const answerPreview = (number: string) =>
  screen.queryByRole('image', {
    name: label('admin.questions.form.answers.image.preview', { number }),
  });

// The question's text and two answers, the first correct: everything but
// the images is valid.
async function fillValidQuestion() {
  await fireEvent.changeText(field(label('admin.questions.form.text')), 'Welches Tier ist das?');
  await fireEvent.changeText(
    field(label('admin.questions.form.answers.text', { number: '1' })),
    'Fuchs',
  );
  await fireEvent.changeText(
    field(label('admin.questions.form.answers.text', { number: '2' })),
    'Dachs',
  );
  await fireEvent.press(
    screen.getByRole('checkbox', {
      name: label('admin.questions.form.answers.correct', { number: '1' }),
    }),
  );
}

async function save() {
  await fireEvent.press(button(label('admin.questions.form.save')));
}

// The texts come from de.json, so the form must show German, whatever the
// device's language.
let languageBefore: string;
beforeAll(async () => {
  languageBefore = i18n.language;
  await i18n.changeLanguage('de');
});
afterAll(async () => {
  await i18n.changeLanguage(languageBefore);
});

beforeEach(() => {
  picker.launchImageLibraryAsync.mockReset();
});

describe('QuestionForm: question image', () => {
  it('picks an image from the library, images only, and shows its preview and an alt text field', async () => {
    await renderForm();
    picks(FOX);

    await fireEvent.press(button(label('admin.questions.form.image.pick')));

    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    const [options] = picker.launchImageLibraryAsync.mock.calls[0] as [{ mediaTypes?: unknown }];
    expect([options?.mediaTypes].flat()).toEqual(['images']);
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    expect(sourceUri(questionPreview() as TestInstance)).toBe(FOX.uri);
    expect(field(label('admin.questions.form.image.alt'))).toBeOnTheScreen();
  });

  it('refuses to save an image without an alt text and explains why', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picks(FOX);
    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), ' \t ');

    await save();

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageAltRequired')),
    ).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a picked image under a new UUID name, with its alt text and the file to upload', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picks(FOX);
    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Fuchs im Gras');

    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.image_path).toMatch(UUID_NAME);
    expect(values.image_path?.endsWith('.png')).toBe(true);
    expect(values.image_path).not.toMatch(/fuchs/i);
    expect(values.image_alt).toBe('Ein Fuchs im Gras');
    expect(values.image_file).toEqual({ uri: FOX.uri, mimeType: 'image/png', size: 2048 });
  });

  it('takes a file of exactly 5 MiB', async () => {
    await renderForm();
    picks({ ...FOX, fileSize: MiB5 });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));

    await waitFor(() => expect(questionPreview()).not.toBeNull());
    expect(screen.queryByText(label('admin.questions.form.errors.imageTooLarge'))).toBeNull();
  });

  it('refuses a file larger than 5 MiB as soon as it is picked, and never submits it', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picks({ ...FOX, fileSize: MiB5 + 1 });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageTooLarge')),
    ).toBeOnTheScreen();
    await save();
    await waitFor(() => expect(button(label('admin.questions.form.save'))).toBeEnabled());
    expect(submitted(onSubmit).some((values) => values.image_file?.uri === FOX.uri)).toBe(false);
  });

  it('refuses a file of another type than png, jpeg or webp as soon as it is picked, and never submits it', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    const gif = { ...FOX, uri: 'file:///picked/fuchs.gif', mimeType: 'image/gif' };
    picks(gif);

    await fireEvent.press(button(label('admin.questions.form.image.pick')));

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageType')),
    ).toBeOnTheScreen();
    await save();
    await waitFor(() => expect(button(label('admin.questions.form.save'))).toBeEnabled());
    expect(submitted(onSubmit).some((values) => values.image_file?.uri === gif.uri)).toBe(false);
  });

  it('leaves the form as it was when the picker is cancelled', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(questionPreview()).toBeNull();
    expect(submitted(onSubmit)[0]).toMatchObject({
      image_path: null,
      image_alt: null,
      image_file: null,
    });
  });

  it('removes a picked image again', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picks(FOX);
    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Fuchs');

    await fireEvent.press(button(label('admin.questions.form.image.remove')));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(questionPreview()).toBeNull();
    expect(screen.queryByLabelText(label('admin.questions.form.image.alt'))).toBeNull();
    expect(submitted(onSubmit)[0]).toMatchObject({
      image_path: null,
      image_alt: null,
      image_file: null,
    });
  });

  it('shows a stored image and its alt text when editing, and keeps both when saved unchanged', async () => {
    const onSubmit = await renderForm(STORED);

    const preview = await waitFor(() => {
      const found = questionPreview();
      if (!found) throw new Error('no preview of the stored image');
      return found;
    });
    expect(sourceUri(preview)).toBe(publicUrl(STORED_PATH));
    expect(field(label('admin.questions.form.image.alt'))).toHaveDisplayValue('Ein Tier im Gras');
    expect(button(label('admin.questions.form.image.replace'))).toBeOnTheScreen();

    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)[0]).toMatchObject({
      image_path: STORED_PATH,
      image_alt: 'Ein Tier im Gras',
      image_file: null,
    });
  });

  it('replaces a stored image with a newly picked one under a new name', async () => {
    const onSubmit = await renderForm(STORED);
    picks(BADGER);

    await fireEvent.press(
      await screen.findByRole('button', {
        name: label('admin.questions.form.image.replace'),
      }),
    );
    await waitFor(() => expect(sourceUri(questionPreview() as TestInstance)).toBe(BADGER.uri));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.image_path).toMatch(UUID_NAME);
    expect(values.image_path?.endsWith('.webp')).toBe(true);
    expect(values.image_path).not.toBe(STORED_PATH);
    expect(values.image_file).toEqual({ uri: BADGER.uri, mimeType: 'image/webp', size: 4096 });
  });

  it('removes a stored image', async () => {
    const onSubmit = await renderForm(STORED);

    await fireEvent.press(
      await screen.findByRole('button', { name: label('admin.questions.form.image.remove') }),
    );
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(questionPreview()).toBeNull();
    expect(submitted(onSubmit)[0]).toMatchObject({
      image_path: null,
      image_alt: null,
      image_file: null,
    });
  });
});

describe('QuestionForm: picked files without a type or size', () => {
  it('takes the type from the file name when the picker gives none', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picksPartly({ uri: 'file:///picked/foto.jpg', fileName: 'Fuchs im Gras.jpg', fileSize: 2048 });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Fuchs');
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.image_path).toMatch(UUID_NAME);
    expect(values.image_path?.endsWith('.jpg')).toBe(true);
    expect(values.image_file).toMatchObject({
      uri: 'file:///picked/foto.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('takes the type from the URI when the picker gives neither a type nor a file name', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picksPartly({ uri: 'file:///picked/ABC123.WEBP', fileSize: 2048 });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Dachs');
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.image_path?.endsWith('.webp')).toBe(true);
    expect(values.image_file).toMatchObject({ mimeType: 'image/webp' });
  });

  it('refuses a file without a type whose name has no png, jpeg or webp extension, and never submits it', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picksPartly({ uri: 'file:///picked/IMG_0001.HEIC', fileName: 'IMG_0001.HEIC', fileSize: 2048 });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageType')),
    ).toBeOnTheScreen();
    expect(questionPreview()).toBeNull();
    await save();
    await waitFor(() => expect(button(label('admin.questions.form.save'))).toBeEnabled());
    expect(
      submitted(onSubmit).some(
        (values) => values.image_file?.uri === 'file:///picked/IMG_0001.HEIC',
      ),
    ).toBe(false);
  });

  it('takes a file whose size the picker does not know, for the bucket to check at upload', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picksPartly({ uri: FOX.uri, mimeType: 'image/png', fileName: FOX.fileName });

    await fireEvent.press(button(label('admin.questions.form.image.pick')));
    await waitFor(() => expect(questionPreview()).not.toBeNull());
    expect(screen.queryByText(label('admin.questions.form.errors.imageTooLarge'))).toBeNull();
    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Fuchs');
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)[0].image_file).toMatchObject({
      uri: FOX.uri,
      mimeType: 'image/png',
    });
  });
});

describe('QuestionForm: answer images', () => {
  it('picks an image for an answer, previews it, requires its alt text, and submits it with that answer', async () => {
    const onSubmit = await renderForm();
    await fillValidQuestion();
    picks(BADGER);

    await fireEvent.press(
      button(label('admin.questions.form.answers.image.pick', { number: '2' })),
    );
    await waitFor(() => expect(answerPreview('2')).not.toBeNull());
    expect(sourceUri(answerPreview('2') as TestInstance)).toBe(BADGER.uri);
    expect(answerPreview('1')).toBeNull();

    await save();
    expect(
      await screen.findByText(label('admin.questions.form.errors.imageAltRequired')),
    ).toBeOnTheScreen();
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.changeText(
      field(label('admin.questions.form.answers.image.alt', { number: '2' })),
      'Ein Dachs vor seinem Bau',
    );
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.answers[1].image_path).toMatch(UUID_NAME);
    expect(values.answers[1].image_alt).toBe('Ein Dachs vor seinem Bau');
    expect(values.answers[1].image_file).toEqual({
      uri: BADGER.uri,
      mimeType: 'image/webp',
      size: 4096,
    });
    expect(values.answers[0]).toMatchObject({ image_path: null, image_file: null });
    expect(values.image_path).toBeNull();
  });

  it('refuses an answer file larger than 5 MiB as soon as it is picked', async () => {
    await renderForm();
    picks({ ...BADGER, fileSize: MiB5 + 1 });

    await fireEvent.press(
      button(label('admin.questions.form.answers.image.pick', { number: '1' })),
    );

    expect(
      await screen.findByText(label('admin.questions.form.errors.imageTooLarge')),
    ).toBeOnTheScreen();
  });

  it('replaces a stored answer image with a newly picked one under a new name, keeping its alt text', async () => {
    const onSubmit = await renderForm(STORED);
    picks(BADGER);

    await fireEvent.press(
      await screen.findByRole('button', {
        name: label('admin.questions.form.answers.image.replace', { number: '1' }),
      }),
    );
    await waitFor(() => expect(sourceUri(answerPreview('1') as TestInstance)).toBe(BADGER.uri));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(values.answers[0].image_path).toMatch(UUID_NAME);
    expect(values.answers[0].image_path?.endsWith('.webp')).toBe(true);
    expect(values.answers[0].image_path).not.toBe(STORED_ANSWER_PATH);
    expect(values.answers[0].image_alt).toBe('Ein roter Fuchs');
    expect(values.answers[0].image_file).toEqual({
      uri: BADGER.uri,
      mimeType: 'image/webp',
      size: 4096,
    });
    expect(values.answers[1]).toMatchObject({ image_path: null, image_file: null });
    expect(values).toMatchObject({ image_path: STORED_PATH, image_file: null });
  });

  it('shows a stored answer image with its alt text when editing, and removes it', async () => {
    const onSubmit = await renderForm(STORED);

    const preview = await waitFor(() => {
      const found = answerPreview('1');
      if (!found) throw new Error('no preview of the stored answer image');
      return found;
    });
    expect(sourceUri(preview)).toBe(publicUrl(STORED_ANSWER_PATH));
    expect(
      field(label('admin.questions.form.answers.image.alt', { number: '1' })),
    ).toHaveDisplayValue('Ein roter Fuchs');

    await fireEvent.press(
      button(label('admin.questions.form.answers.image.remove', { number: '1' })),
    );
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [values] = submitted(onSubmit);
    expect(answerPreview('1')).toBeNull();
    expect(values.answers[0]).toMatchObject({
      image_path: null,
      image_alt: null,
      image_file: null,
    });
    expect(values.image_path).toBe(STORED_PATH);
  });
});

// Found by the ui-verifier: a refused save's alt text message stayed after
// the image it was about was removed. Like the answer rules, a message from
// a save attempt goes as soon as what it is about changed.
describe('QuestionForm: outdated alt text messages', () => {
  const altRequired = () => label('admin.questions.form.errors.imageAltRequired');

  it('drops the question image alt text message once the image is removed', async () => {
    const onSubmit = await renderForm(STORED);
    await fireEvent.changeText(
      await screen.findByLabelText(label('admin.questions.form.image.alt')),
      '',
    );
    await save();
    expect(await screen.findByText(altRequired())).toBeOnTheScreen();

    await fireEvent.press(button(label('admin.questions.form.image.remove')));

    await waitFor(() => expect(screen.queryByText(altRequired())).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('drops the question image alt text message once an alt text is written', async () => {
    await renderForm(STORED);
    await fireEvent.changeText(
      await screen.findByLabelText(label('admin.questions.form.image.alt')),
      '',
    );
    await save();
    expect(await screen.findByText(altRequired())).toBeOnTheScreen();

    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), 'Ein Tier im Gras');

    await waitFor(() => expect(screen.queryByText(altRequired())).toBeNull());
  });

  it('drops an answer image alt text message once that image is removed', async () => {
    const onSubmit = await renderForm(STORED);
    await fireEvent.changeText(
      await screen.findByLabelText(
        label('admin.questions.form.answers.image.alt', { number: '1' }),
      ),
      '',
    );
    await save();
    expect(await screen.findByText(altRequired())).toBeOnTheScreen();

    await fireEvent.press(
      button(label('admin.questions.form.answers.image.remove', { number: '1' })),
    );

    await waitFor(() => expect(screen.queryByText(altRequired())).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the alt text message while an alt text is still missing', async () => {
    await renderForm(STORED);
    await fireEvent.changeText(
      await screen.findByLabelText(label('admin.questions.form.image.alt')),
      '',
    );
    await save();
    expect(await screen.findByText(altRequired())).toBeOnTheScreen();

    await fireEvent.changeText(field(label('admin.questions.form.image.alt')), '  ');

    await waitFor(() => expect(screen.getByText(altRequired())).toBeOnTheScreen());
  });
});
