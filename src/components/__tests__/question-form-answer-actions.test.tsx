import { render, screen, within } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import type { TestInstance } from 'test-renderer';

import { QuestionForm } from '@/components/question-form';
import i18n from '@/i18n';
import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';

// Issue #117, short action labels: the answers in the question form are a
// list too. Each answer's actions show short labels from i18next — "Bild
// auswählen" / "Bild ersetzen" / "Bild entfernen" (the same words as the
// question's own image buttons), "↑ Nach oben", "↓ Nach unten",
// "Entfernen" — and keep an accessible name "<visible label>: Antwort n"
// that starts with the label (WCAG 2.5.3; the move buttons' arrow is
// decorative and left out) and names the answer, so two answers' buttons
// stay apart. Order: image, move, remove last. The names come from the keys
// the form already uses (admin.questions.form.answers.remove with {number},
// …), so lookups by key still find each answer's own button. The question's
// own image buttons and the answer's checkbox, text and alt fields stay as
// they are.
//
// Boundaries: the device's picker (expo-image-picker) and the Storage
// client's public URL.

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

// Reads a text from de.json or en.json by path, so keys that don't exist yet
// fail at run time with their name instead of breaking the typecheck.
function text(key: string, lng: 'de' | 'en'): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      lng === 'de' ? de : en,
    );
  if (typeof value !== 'string') throw new Error(`${lng}.json has no text for ${key}`);
  return value;
}

// A text in the language shown, placeholders filled in through i18next,
// after checking the key exists.
function label(key: string, values: Record<string, string> = {}) {
  const lng = i18n.language === 'en' ? 'en' : 'de';
  text(key, lng);
  return (i18n.t as (key: string, options: object) => string)(key, { ...values, lng });
}

type Initial = ComponentProps<typeof QuestionForm>['initial'];

// A stored question: Schwarz (with an image), Rot and Grün (without).
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
      image_path: '0a1b2c3d-0000-4000-8000-000000000003.jpg',
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

async function renderForm() {
  await render(
    <QuestionForm initial={STORED} pending={false} failure={null} onSubmit={jest.fn()} />,
  );
}

const roleOf = (node: TestInstance) =>
  String(node.props.role ?? node.props.accessibilityRole ?? '');

const isAction = (node: TestInstance) => /^(button|link)$/.test(roleOf(node));

function textOf(node: TestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

const visibleText = (node: TestInstance) => textOf(node).replace(/\s+/g, ' ').trim();

const accessibleName = (node: TestInstance) =>
  String(node.props['aria-label'] ?? node.props.accessibilityLabel ?? visibleText(node));

// The visible label without the move buttons' decorative arrow.
const spoken = (shown: string) => shown.replace(/^[↑↓]\s*/u, '');

// "Antwort n" as the answer's text field is labelled: the row's name.
const answerName = (number: number) =>
  label('admin.questions.form.answers.text', { number: String(number) });

// The answer's card: the closest ancestor of its text field that holds actions.
function answerCard(number: number): TestInstance {
  const field = screen.getByLabelText(answerName(number));
  for (let current: TestInstance | null = field.parent; current; current = current.parent) {
    if (current.queryAll((node) => typeof node.type === 'string' && isAction(node)).length > 0) {
      return current;
    }
  }
  throw new Error(`Answer ${number} has no actions`);
}

const answerActions = (number: number) =>
  answerCard(number).queryAll((node) => typeof node.type === 'string' && isAction(node));

type Expected = { label: string; key: string };

// German, from the issue's table, in the order image, move, remove.
function expectedActions(withImage: boolean): Expected[] {
  const image: Expected[] = withImage
    ? [
        { label: 'Bild ersetzen', key: 'admin.questions.form.answers.image.replace' },
        { label: 'Bild entfernen', key: 'admin.questions.form.answers.image.remove' },
      ]
    : [{ label: 'Bild auswählen', key: 'admin.questions.form.answers.image.pick' }];
  return [
    ...image,
    { label: '↑ Nach oben', key: 'admin.questions.form.answers.moveUp' },
    { label: '↓ Nach unten', key: 'admin.questions.form.answers.moveDown' },
    { label: 'Entfernen', key: 'admin.questions.form.answers.remove' },
  ];
}

let languageBefore: string;
beforeAll(() => {
  languageBefore = i18n.language;
});
beforeEach(async () => {
  await i18n.changeLanguage('de');
});
afterAll(async () => {
  await i18n.changeLanguage(languageBefore);
});

describe('QuestionForm: short answer action labels', () => {
  it('shows each answer the short labels, in the order image, move, remove', async () => {
    await renderForm();

    expect(answerActions(1).map(visibleText)).toEqual(
      expectedActions(true).map((action) => action.label),
    );
    for (const number of [2, 3]) {
      expect(answerActions(number).map(visibleText)).toEqual(
        expectedActions(false).map((action) => action.label),
      );
    }
  });

  it('names every answer action "<label>: Antwort n", starting with its visible label', async () => {
    await renderForm();

    for (const number of [1, 2, 3]) {
      const expected = expectedActions(number === 1);
      const actions = answerActions(number);
      expect(actions.map(accessibleName)).toEqual(
        expected.map((action) => `${spoken(action.label)}: ${answerName(number)}`),
      );
      expected.forEach((action, index) => {
        expect(accessibleName(actions[index]!)).toBe(label(action.key, { number: String(number) }));
      });
    }
  });

  it("keeps two answers' actions apart: each answer's own button by its full name", async () => {
    await renderForm();

    for (const shown of ['Entfernen', '↑ Nach oben', 'Bild auswählen']) {
      const numbers = shown === 'Bild auswählen' ? [2, 3] : [1, 2, 3];
      const found = numbers.map((number) =>
        screen.getByRole('button', { name: `${spoken(shown)}: ${answerName(number)}` }),
      );
      expect(new Set(found).size).toBe(numbers.length);
      numbers.forEach((number, index) => {
        expect(answerActions(number)).toContain(found[index]);
        expect(within(answerCard(number)).getAllByText(shown, { exact: true })).toHaveLength(1);
      });
    }
    // The question's own image button keeps its plain name, so it never
    // collides with an answer's.
    expect(screen.getByRole('button', { name: label('admin.questions.form.image.pick') })).not.toBe(
      screen.getByRole('button', { name: `Bild auswählen: ${answerName(2)}` }),
    );
  });

  it('shows the short labels and the answer names in English too', async () => {
    await i18n.changeLanguage('en');
    await renderForm();

    // An action shows the same short label on every answer.
    const shownFor = new Map<string, string>();
    for (const number of [1, 2, 3]) {
      const expected = expectedActions(number === 1);
      const actions = answerActions(number);
      expect(actions).toHaveLength(expected.length);
      expected.forEach((action, index) => {
        const node = actions[index]!;
        const shown = visibleText(node);
        expect(shown).not.toBe(action.label);
        expect(shown).not.toContain(answerName(number));
        const before = shownFor.get(action.label);
        if (before === undefined) shownFor.set(action.label, shown);
        else expect(shown).toBe(before);
        if (action.label.startsWith('↑')) expect(shown).toMatch(/^↑ \S/u);
        if (action.label.startsWith('↓')) expect(shown).toMatch(/^↓ \S/u);
        expect(accessibleName(node)).toBe(`${spoken(shown)}: ${answerName(number)}`);
        expect(accessibleName(node)).toBe(label(action.key, { number: String(number) }));
      });
    }
  });
});
