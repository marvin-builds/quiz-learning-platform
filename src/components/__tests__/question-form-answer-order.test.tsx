import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import type { TestInstance } from 'test-renderer';

import { QuestionForm } from '@/components/question-form';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Reordering the answers in the question form (#84). Every answer has a
// "move up" and a "move down" button, named with the answer's number like
// its other controls, usable by keyboard and screen reader (no drag). The
// first answer's "up" and the last answer's "down" are disabled, not hidden,
// and with a single answer both are. A move changes only the order of the
// form's answers: the text, the correct mark, a stored image and a picked
// (still staged) image move with the answer, a new answer without an id
// included. onSubmit gets the answers in the new order; save_question then
// stores that order (save_question_answer_order.test.sql), so the save is
// the one database call.
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

// Reads a text from de.json or en.json by path, so keys that don't exist yet
// fail at run time with their name instead of breaking the typecheck.
function text(key: string, lng: 'de' | 'en' = 'de'): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

// A text with its placeholders filled in through i18next, after checking
// the key exists.
function label(key: string, values: Record<string, string> = {}, lng: 'de' | 'en' = 'de') {
  text(key, lng);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng });
}

type Initial = ComponentProps<typeof QuestionForm>['initial'];

type SubmittedAnswer = {
  id: string | null;
  text: string;
  is_correct: boolean;
  image_path: string | null;
  image_alt: string | null;
  image_file: { uri: string } | null;
};

const submittedAnswers = (onSubmit: jest.Mock): SubmittedAnswer[][] =>
  onSubmit.mock.calls.map(([values]) => (values as { answers: SubmittedAnswer[] }).answers);

const FOX_PATH = '0a1b2c3d-0000-4000-8000-000000000003.jpg';

// A stored multiple-choice question: Schwarz (correct, with an image), Rot
// (correct), Grün (wrong).
const STORED = {
  text: 'Welche Farben hat die deutsche Flagge?',
  explanation: null,
  multiple_correct: true,
  image_path: null,
  image_alt: null,
  answers: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      text: 'Schwarz',
      is_correct: true,
      image_path: FOX_PATH,
      image_alt: 'Ein schwarzer Streifen',
    },
    {
      id: '40000000-0000-4000-8000-000000000002',
      text: 'Rot',
      is_correct: true,
      image_path: null,
      image_alt: null,
    },
    {
      id: '40000000-0000-4000-8000-000000000003',
      text: 'Grün',
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
const moveUp = (number: number) =>
  button(label('admin.questions.form.answers.moveUp', { number: String(number) }));
const moveDown = (number: number) =>
  button(label('admin.questions.form.answers.moveDown', { number: String(number) }));
const answerField = (number: number) =>
  screen.getByLabelText(label('admin.questions.form.answers.text', { number: String(number) }));
const correctBox = (number: number) =>
  screen.getByRole('checkbox', {
    name: label('admin.questions.form.answers.correct', { number: String(number) }),
  });
const answerPreview = (number: number) =>
  screen.queryByRole('image', {
    name: label('admin.questions.form.answers.image.preview', { number: String(number) }),
  });

function isChecked(element: TestInstance): boolean | undefined {
  const props = element.props as Record<string, unknown>;
  const state = props.accessibilityState as { checked?: boolean } | undefined;
  return (props['aria-checked'] as boolean | undefined) ?? state?.checked;
}

function sourceUri(image: TestInstance): string | undefined {
  const source = image.props.source as { uri?: string } | { uri?: string }[] | undefined;
  return Array.isArray(source) ? source[0]?.uri : source?.uri;
}

// The answers' texts as the fields show them, top to bottom.
function shownTexts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => String(answerField(i + 1).props.value));
}

async function save() {
  await fireEvent.press(button(label('admin.questions.form.save')));
}

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

describe('QuestionForm: answer order controls', () => {
  it('gives every answer a move-up and a move-down button named with its number', async () => {
    await renderForm(STORED);

    for (const number of [1, 2, 3]) {
      expect(moveUp(number)).toBeOnTheScreen();
      expect(moveDown(number)).toBeOnTheScreen();
    }
  });

  it('has the move texts in English too', async () => {
    expect(label('admin.questions.form.answers.moveUp', { number: '2' }, 'en')).toContain('2');
    expect(label('admin.questions.form.answers.moveDown', { number: '2' }, 'en')).toContain('2');
    expect(label('admin.questions.form.answers.moveUp', { number: '2' }, 'en')).not.toBe(
      label('admin.questions.form.answers.moveDown', { number: '2' }, 'en'),
    );
  });

  it("disables the first answer's move-up and the last answer's move-down, without hiding them", async () => {
    await renderForm(STORED);

    expect(moveUp(1)).toBeDisabled();
    expect(moveDown(1)).toBeEnabled();
    expect(moveUp(2)).toBeEnabled();
    expect(moveDown(2)).toBeEnabled();
    expect(moveUp(3)).toBeEnabled();
    expect(moveDown(3)).toBeDisabled();
  });

  it('disables both move buttons of a single answer', async () => {
    const single = {
      ...(STORED as object),
      answers: [(STORED as unknown as { answers: unknown[] }).answers[0]],
    } as unknown as Initial;
    await renderForm(single);

    expect(moveUp(1)).toBeDisabled();
    expect(moveDown(1)).toBeDisabled();
  });

  it('updates which buttons are disabled after a move and after adding an answer', async () => {
    await renderForm(STORED);

    // Positions, not answers, decide: the moved answer is now second and
    // enabled both ways, the one that came up is first and can't go higher.
    await fireEvent.press(moveDown(1));

    expect(shownTexts(3)).toEqual(['Rot', 'Schwarz', 'Grün']);
    expect(moveUp(1)).toBeDisabled();
    expect(moveDown(1)).toBeEnabled();
    expect(moveUp(2)).toBeEnabled();
    expect(moveDown(2)).toBeEnabled();
    expect(moveDown(3)).toBeDisabled();

    await fireEvent.press(button(label('admin.questions.form.answers.add')));

    expect(moveDown(3)).toBeEnabled();
    expect(moveUp(4)).toBeEnabled();
    expect(moveDown(4)).toBeDisabled();
  });
});

describe('QuestionForm: moving answers', () => {
  it('moves an answer down with its text, its correct mark and its stored image', async () => {
    await renderForm(STORED);

    await fireEvent.press(moveDown(1));

    expect(shownTexts(3)).toEqual(['Rot', 'Schwarz', 'Grün']);
    expect(isChecked(correctBox(1))).toBe(true);
    expect(isChecked(correctBox(2))).toBe(true);
    expect(isChecked(correctBox(3))).toBe(false);
    await waitFor(() => expect(answerPreview(2)).not.toBeNull());
    expect(sourceUri(answerPreview(2) as TestInstance)).toBe(publicUrl(FOX_PATH));
    expect(answerPreview(1)).toBeNull();
  });

  it('moves an answer up with its text and its mark', async () => {
    await renderForm(STORED);

    await fireEvent.press(moveUp(3));

    expect(shownTexts(3)).toEqual(['Schwarz', 'Grün', 'Rot']);
    expect(isChecked(correctBox(2))).toBe(false);
    expect(isChecked(correctBox(3))).toBe(true);
  });

  it('submits the answers in the new order, each with its id, text, mark and image', async () => {
    const onSubmit = await renderForm(STORED);

    await fireEvent.press(moveUp(3));
    await fireEvent.press(moveUp(2));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [answers] = submittedAnswers(onSubmit);
    expect(
      answers.map(({ id, text: answerText, is_correct, image_path, image_alt }) => ({
        id,
        text: answerText,
        is_correct,
        image_path,
        image_alt,
      })),
    ).toEqual([
      {
        id: '40000000-0000-4000-8000-000000000003',
        text: 'Grün',
        is_correct: false,
        image_path: null,
        image_alt: null,
      },
      {
        id: '40000000-0000-4000-8000-000000000001',
        text: 'Schwarz',
        is_correct: true,
        image_path: FOX_PATH,
        image_alt: 'Ein schwarzer Streifen',
      },
      {
        id: '40000000-0000-4000-8000-000000000002',
        text: 'Rot',
        is_correct: true,
        image_path: null,
        image_alt: null,
      },
    ]);
  });

  it('moves a new answer, typed text and a picked image included, above the stored ones', async () => {
    const onSubmit = await renderForm(STORED);
    await fireEvent.press(button(label('admin.questions.form.answers.add')));
    await fireEvent.changeText(answerField(4), 'Gold');
    await fireEvent.press(correctBox(4));
    picker.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///picked/gold.png',
          mimeType: 'image/png',
          fileSize: 2048,
          fileName: 'gold.png',
          width: 640,
          height: 480,
          type: 'image',
        },
      ],
    });
    await fireEvent.press(
      button(label('admin.questions.form.answers.image.pick', { number: '4' })),
    );
    await waitFor(() => expect(answerPreview(4)).not.toBeNull());
    await fireEvent.changeText(
      screen.getByLabelText(label('admin.questions.form.answers.image.alt', { number: '4' })),
      'Ein goldener Streifen',
    );

    for (const number of [4, 3, 2]) await fireEvent.press(moveUp(number));

    expect(shownTexts(4)).toEqual(['Gold', 'Schwarz', 'Rot', 'Grün']);
    expect(sourceUri(answerPreview(1) as TestInstance)).toBe('file:///picked/gold.png');
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [answers] = submittedAnswers(onSubmit);
    expect(answers.map((answer) => answer.text)).toEqual(['Gold', 'Schwarz', 'Rot', 'Grün']);
    expect(answers[0]).toMatchObject({
      id: null,
      is_correct: true,
      image_alt: 'Ein goldener Streifen',
      image_file: expect.objectContaining({ uri: 'file:///picked/gold.png' }),
    });
    expect(answers[1]).toMatchObject({
      id: '40000000-0000-4000-8000-000000000001',
      image_path: FOX_PATH,
      image_file: null,
    });
  });

  it('keeps the order when moving down and back up again', async () => {
    const onSubmit = await renderForm(STORED);

    await fireEvent.press(moveDown(2));
    await fireEvent.press(moveUp(3));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submittedAnswers(onSubmit)[0].map((answer) => answer.text)).toEqual([
      'Schwarz',
      'Rot',
      'Grün',
    ]);
  });

  it('does nothing when a disabled boundary button is pressed', async () => {
    const onSubmit = await renderForm(STORED);

    await fireEvent.press(moveUp(1));
    await fireEvent.press(moveDown(3));
    await save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submittedAnswers(onSubmit)[0].map((answer) => answer.text)).toEqual([
      'Schwarz',
      'Rot',
      'Grün',
    ]);
  });
});
