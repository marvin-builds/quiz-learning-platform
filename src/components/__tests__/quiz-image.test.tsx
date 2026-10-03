import { fireEvent, render, screen } from '@testing-library/react-native';

import { QuizImage } from '@/components/quiz-image';

// The player reuses one QuizImage when it moves to the next question, so a
// failed load must not carry over to a different image.

jest.mock('@/lib/supabase', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `http://storage.test/storage/v1/object/public/${bucket}/${path}` },
        }),
      }),
    },
  },
}));

describe('QuizImage', () => {
  it('tries a new image after the previous one failed to load', async () => {
    const { rerender } = await render(
      <QuizImage path="a.png" alt="Erstes Bild" className="h-24" />,
    );
    await fireEvent(screen.getByRole('image', { name: 'Erstes Bild' }), 'error', {
      nativeEvent: { error: 'HTTP 404' },
    });
    expect(screen.getByText('Erstes Bild')).toBeOnTheScreen();

    await rerender(<QuizImage path="b.png" alt="Zweites Bild" className="h-24" />);

    expect(screen.getByRole('image', { name: 'Zweites Bild' })).toBeOnTheScreen();
  });
});
