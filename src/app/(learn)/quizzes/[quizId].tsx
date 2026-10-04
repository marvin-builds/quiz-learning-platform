import { type UseMutationOptions, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { QuizImage } from '@/components/quiz-image';
import { Button, ErrorState, NotFoundState, StatusMessage } from '@/components/status';
import { fetchAttemptScore, fetchQuiz, fetchQuizQuestions } from '@/lib/content';
import { ensureSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

type Quiz = NonNullable<Awaited<ReturnType<typeof fetchQuiz>>>;
type Question = Awaited<ReturnType<typeof fetchQuizQuestions>>[number];

// start_attempt raises this for a quiz that can't be scored (hidden, without
// questions, or without a correct answer); trying again won't help.
const NOT_AVAILABLE = 'not available';

export default function QuizScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  const quiz = useQuery({ queryKey: ['quiz', quizId], queryFn: () => fetchQuiz(quizId) });

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={quiz.data?.title ?? t('quiz.pageTitle')} />
      <View className="mx-auto w-full max-w-2xl">
        <QuizBody quiz={quiz} />
      </View>
    </ScrollView>
  );
}

function QuizBody({ quiz }: { quiz: ReturnType<typeof useQuery<Quiz | null>> }) {
  const { t } = useTranslation();
  if (quiz.isPending) return <StatusMessage text={t('quiz.loading')} />;
  if (quiz.isError) {
    return (
      <ErrorState
        message={t('quiz.error')}
        retryLabel={t('quiz.retry')}
        onRetry={() => quiz.refetch()}
      />
    );
  }
  if (quiz.data === null) {
    return <NotFoundState message={t('quiz.notFound')} backLabel={t('quiz.backToCategories')} />;
  }
  return <QuizContent quiz={quiz.data} />;
}

function QuizContent({ quiz }: { quiz: Quiz }) {
  const { t } = useTranslation();
  const start = useGuardedMutation({
    mutationFn: async () => {
      await ensureSession();
      const { data, error } = await supabase.rpc('start_attempt', { quiz_id: quiz.id });
      if (error) throw error;
      return data;
    },
  });

  return (
    <>
      <Text role="heading" className="mb-2 text-2xl font-bold text-gray-900">
        {quiz.title}
      </Text>
      {start.isSuccess ? (
        // Keyed by the attempt, so Play again starts over with fresh state.
        <Player
          key={start.data}
          quiz={quiz}
          attemptId={start.data}
          onPlayAgain={() => start.run()}
        />
      ) : (
        <>
          {quiz.description ? (
            <Text className="mb-2 text-base text-gray-600">{quiz.description}</Text>
          ) : null}
          <Text className="mb-6 text-base text-gray-600">
            {t('quiz.questionCount', { count: quiz.questionCount })}
          </Text>
          <StartAction quiz={quiz} start={start} />
        </>
      )}
    </>
  );
}

function StartAction({
  quiz,
  start,
}: {
  quiz: Quiz;
  start: ReturnType<typeof useGuardedMutation<string>>;
}) {
  const { t } = useTranslation();
  if (quiz.questionCount === 0) return <StatusMessage text={t('quiz.noQuestions')} />;
  if (start.error?.message === NOT_AVAILABLE) {
    return <StatusMessage text={t('quiz.unavailable')} />;
  }
  if (start.isError) {
    return (
      <ErrorState
        message={t('quiz.startError')}
        retryLabel={t('quiz.retry')}
        onRetry={() => start.run()}
      />
    );
  }
  return <Button label={t('quiz.start')} disabled={start.busy} onPress={() => start.run()} />;
}

function Player({
  quiz,
  attemptId,
  onPlayAgain,
}: {
  quiz: Quiz;
  attemptId: string;
  onPlayAgain: () => void;
}) {
  const { t } = useTranslation();
  // Read once per attempt: the questions must match the ones it started with.
  const questions = useQuery({
    queryKey: ['quiz-questions', quiz.id, attemptId],
    queryFn: () => fetchQuizQuestions(quiz.id),
    staleTime: Infinity,
  });
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const [showResult, setShowResult] = useState(false);
  // The recorded result of the current question; its feedback shows until Next.
  const submit = useGuardedMutation({
    mutationFn: async (answer: { questionId: string; answerIds: string[] }) => {
      const { data, error } = await supabase
        .rpc('submit_answer', {
          attempt_id: attemptId,
          question_id: answer.questionId,
          answer_ids: answer.answerIds,
        })
        .single();
      if (error) throw error;
      return data;
    },
  });

  if (showResult) {
    return <Result attemptId={attemptId} categoryId={quiz.category_id} onPlayAgain={onPlayAgain} />;
  }
  if (questions.isPending) return <StatusMessage text={t('quiz.questionsLoading')} />;
  if (questions.isError) {
    return (
      <ErrorState
        message={t('quiz.questionsError')}
        retryLabel={t('quiz.retry')}
        onRetry={() => questions.refetch()}
      />
    );
  }

  const question = questions.data[index];
  const isLast = index === questions.data.length - 1;
  const feedback = submit.isSuccess ? submit.data : null;
  const send = () => submit.run({ questionId: question.id, answerIds: picks });
  const pick = (answerId: string) =>
    setPicks((current) => togglePick(current, answerId, question.multiple_correct));
  const next = () => {
    submit.reset();
    setPicks([]);
    setIndex((current) => current + 1);
  };

  return (
    <View>
      <Text className="mb-2 text-sm font-semibold text-gray-600">
        {t('quiz.progress', { current: index + 1, total: questions.data.length })}
      </Text>
      <QuestionView
        question={question}
        picks={picks}
        feedback={feedback}
        disabled={submit.busy || feedback !== null}
        onPick={pick}
      />
      {feedback ? (
        <Button
          label={isLast ? t('quiz.seeResult') : t('quiz.next')}
          onPress={isLast ? () => setShowResult(true) : next}
        />
      ) : submit.isError ? (
        <ErrorState
          message={t('quiz.submitError')}
          retryLabel={t('quiz.retry')}
          onRetry={send}
          retryDisabled={picks.length === 0 || submit.busy}
        />
      ) : (
        <Button
          label={t('quiz.submit')}
          disabled={picks.length === 0 || submit.busy}
          onPress={send}
        />
      )}
    </View>
  );
}

/** Single choice: a pick replaces the selection. Multiple choice: it toggles. */
function togglePick(picks: string[], answerId: string, multiple: boolean): string[] {
  if (!multiple) return [answerId];
  return picks.includes(answerId) ? picks.filter((id) => id !== answerId) : [...picks, answerId];
}

/**
 * On web, Pressable presses on Space only for buttons; radios and checkboxes
 * are picked with Space too. onKeyDown exists only in react-native-web's
 * Pressable, so it is spread in rather than typed as a prop.
 */
function pickOnSpace(pick: () => void) {
  return {
    onKeyDown: (event: { key?: string; preventDefault?: () => void }) => {
      if (event.key !== ' ') return;
      event.preventDefault?.();
      pick();
    },
  };
}

type Feedback = {
  is_correct: boolean;
  points: number;
  correct_answer_ids: string[];
  explanation: string | null;
};
type Mark = 'pickedCorrect' | 'pickedWrong' | 'missed';

// Every mark has an icon and a text, so it doesn't rely on color alone.
const MARK_STYLE: Record<Mark, { icon: string; text: string; border: string }> = {
  pickedCorrect: { icon: '✓', text: 'text-green-800', border: 'border-green-700' },
  pickedWrong: { icon: '✗', text: 'text-red-700', border: 'border-red-700' },
  missed: { icon: '!', text: 'text-amber-800', border: 'border-amber-700' },
};

// One point per question (plan § 7), so partial points are "of 1 point".
const POINTS_PER_QUESTION = 1;

/** A picked answer is right or wrong; an unpicked correct one was missed. */
function markOf(answerId: string, picks: string[], feedback: Feedback | null): Mark | null {
  if (!feedback) return null;
  const correct = feedback.correct_answer_ids.includes(answerId);
  if (picks.includes(answerId)) return correct ? 'pickedCorrect' : 'pickedWrong';
  return correct ? 'missed' : null;
}

function QuestionView({
  question,
  picks,
  feedback,
  disabled,
  onPick,
}: {
  question: Question;
  picks: string[];
  feedback: Feedback | null;
  disabled: boolean;
  onPick: (answerId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const labelId = `question-${question.id}`;
  const hintId = `hint-${question.id}`;
  const multiple = question.multiple_correct;

  return (
    <View className="mb-6">
      <Text
        role="heading"
        aria-level={2}
        nativeID={labelId}
        className="mb-2 text-xl font-semibold text-gray-900"
      >
        {question.text}
      </Text>
      {question.image_path ? (
        <View className="mb-3">
          <QuizImage path={question.image_path} alt={question.image_alt} className="h-48 w-full" />
        </View>
      ) : null}
      {multiple && (
        <Text nativeID={hintId} className="mb-2 text-base text-gray-600">
          {t('quiz.multipleHint')}
        </Text>
      )}
      <View
        role={multiple ? 'group' : 'radiogroup'}
        aria-labelledby={labelId}
        aria-describedby={multiple ? hintId : undefined}
        className="gap-3"
      >
        {question.answers.map((answer) => {
          const checked = picks.includes(answer.id);
          const mark = markOf(answer.id, picks, feedback);
          return (
            <Pressable
              key={answer.id}
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={disabled}
              onPress={() => onPick(answer.id)}
              {...pickOnSpace(() => {
                if (!disabled) onPick(answer.id);
              })}
              className={`flex-row items-center rounded-xl border bg-white p-4 ${
                disabled ? '' : 'hover:bg-gray-50'
              } ${mark ? MARK_STYLE[mark].border : checked ? 'border-blue-700' : 'border-gray-200'}`}
            >
              <View
                className={`mr-3 h-5 w-5 border-2 ${multiple ? 'rounded' : 'rounded-full'} ${
                  checked ? 'border-blue-700 bg-blue-700' : 'border-gray-400 bg-white'
                }`}
              />
              <View className="flex-1 gap-2">
                <Text className="text-base text-gray-900">{answer.text}</Text>
                <QuizImage path={answer.image_path} alt={answer.image_alt} className="h-24 w-24" />
                {mark ? (
                  <View className="flex-row items-center gap-1">
                    <Text aria-hidden className={`text-base font-bold ${MARK_STYLE[mark].text}`}>
                      {MARK_STYLE[mark].icon}
                    </Text>
                    <Text className={`text-sm font-semibold ${MARK_STYLE[mark].text}`}>
                      {t(`quiz.feedback.${mark}`)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {/* Mounted before the feedback, so screen readers announce the verdict. */}
      <View aria-live="polite" className="mt-4">
        {feedback ? (
          <Text className="text-lg font-semibold text-gray-900">
            {verdictOf(feedback, i18n.language, t)}
          </Text>
        ) : null}
      </View>
      {feedback?.explanation ? (
        <View className="mt-2 rounded-xl bg-gray-100 p-4">
          <Text className="mb-1 text-sm font-semibold text-gray-700">
            {t('quiz.feedback.explanation')}
          </Text>
          <Text className="text-base text-gray-900">{feedback.explanation}</Text>
        </View>
      ) : null}
    </View>
  );
}

function verdictOf(feedback: Feedback, language: string, t: TFunction): string {
  if (feedback.is_correct) return t('quiz.feedback.correct');
  if (feedback.points > 0) {
    return t('quiz.feedback.partial', {
      points: formatNumber(feedback.points, language),
      count: POINTS_PER_QUESTION,
    });
  }
  return t('quiz.feedback.wrong');
}

/** Points with up to two decimals in the reader's format: 0,67 or 0.67. */
function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
}

/**
 * The attempt's score as the database stored it, never summed here, with a
 * whole-number percentage, Play again and a link back to the category.
 */
function Result({
  attemptId,
  categoryId,
  onPlayAgain,
}: {
  attemptId: string;
  categoryId: string;
  onPlayAgain: () => void;
}) {
  const { t, i18n } = useTranslation();
  const attempt = useQuery({
    queryKey: ['attempt-score', attemptId],
    queryFn: () => fetchAttemptScore(attemptId),
  });

  if (attempt.isPending) return <StatusMessage text={t('quiz.result.loading')} />;
  if (attempt.isError) {
    return (
      <ErrorState
        message={t('quiz.result.error')}
        retryLabel={t('quiz.retry')}
        onRetry={() => attempt.refetch()}
      />
    );
  }

  const { score, max_score: maxScore } = attempt.data;
  const percent = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return (
    <View className="items-center gap-4">
      <Text role="heading" aria-level={2} className="text-xl font-semibold text-gray-900">
        {t('quiz.result.title')}
      </Text>
      <Text className="text-lg text-gray-900">
        {t('quiz.result.score', { score: formatNumber(score, i18n.language), count: maxScore })}
      </Text>
      <Text className="text-3xl font-bold text-gray-900">
        {new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(percent / 100)}
      </Text>
      <View className="w-full">
        <Button label={t('quiz.result.playAgain')} onPress={onPlayAgain} />
      </View>
      <Link href={`/categories/${categoryId}`} asChild>
        <Pressable>
          <Text className="text-base font-semibold text-blue-700 underline">
            {t('quiz.result.backToCategory')}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

/**
 * A mutation that is busy from the press on: TanStack Query reports
 * isPending only on its next notification (scheduled with setTimeout), so a
 * second press before that would send the request twice.
 */
function useGuardedMutation<TData, TVariables = void>(
  options: Pick<UseMutationOptions<TData, Error, TVariables>, 'mutationFn' | 'onSuccess'>,
) {
  const [pressed, setPressed] = useState(false);
  // 'always': offline, the request fails and shows its error with retry,
  // instead of pausing silently until the connection is back.
  const mutation = useMutation({
    ...options,
    networkMode: 'always',
    onSettled: () => setPressed(false),
  });
  const busy = pressed || mutation.isPending;
  return {
    ...mutation,
    busy,
    run: (variables: TVariables) => {
      if (busy) return;
      setPressed(true);
      mutation.mutate(variables);
    },
  };
}
