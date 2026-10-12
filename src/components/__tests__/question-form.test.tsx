import { render, screen } from '@testing-library/react-native';

import { QuestionForm } from '@/components/question-form';
import i18n from '@/i18n';

// The form sits under the screen's level-1 heading, so its answers section
// is a level-2 heading, like the player's subheadings.

describe('QuestionForm', () => {
  it('marks the answers section as a level-2 heading', async () => {
    await render(<QuestionForm pending={false} failure={null} onSubmit={() => {}} />);

    const heading = screen.getByRole('heading', {
      name: i18n.t('admin.questions.form.answers.title'),
    });
    expect(heading).toHaveProp('aria-level', 2);
  });
});
