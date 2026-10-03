import { type UseMutationOptions, useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { QuizImage } from '@/components/quiz-image';
import { Button, ErrorState, NotFoundState, StatusMessage } from '@/components/status';
import { fetchQuiz, fetchQuizQuestions } from '@/lib/content';
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
        <Player quizId={quiz.id} attemptId={start.data} />
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

function Player({ quizId, attemptId }: { quizId: string; attemptId: string }) {
  const { t } = useTranslation();
  // Read once per attempt: the questions must match the ones it started with.
  const questions = useQuery({
    queryKey: ['quiz-questions', quizId, attemptId],
    queryFn: () => fetchQuizQuestions(quizId),
    staleTime: Infinity,
  });
  const [index, setIndex] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  // Returns the recorded result, which item 9 shows before moving on.
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
    onSuccess: () => {
      setIndex((current) => current + 1);
      setPicks([]);
    },
  });

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
  if (index >= questions.data.length) return <StatusMessage text={t('quiz.finished')} />;

  const question = questions.data[index];
  const send = () => submit.run({ questionId: question.id, answerIds: picks });
  const pick = (answerId: string) =>
    setPicks((current) => togglePick(current, answerId, question.multiple_correct));

  return (
    <View>
      <Text className="mb-2 text-sm font-semibold text-gray-600">
        {t('quiz.progress', { current: index + 1, total: questions.data.length })}
      </Text>
      <QuestionView question={question} picks={picks} disabled={submit.busy} onPick={pick} />
      {submit.isError ? (
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

function QuestionView({
  question,
  picks,
  disabled,
  onPick,
}: {
  question: Question;
  picks: string[];
  disabled: boolean;
  onPick: (answerId: string) => void;
}) {
  const { t } = useTranslation();
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
          <QuizImage path={question.image_path} alt={question.image_alt} className="h-48" />
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
              className={`flex-row items-center rounded-xl border bg-white p-4 hover:bg-gray-50 ${
                checked ? 'border-blue-700' : 'border-gray-200'
              }`}
            >
              <View
                className={`mr-3 h-5 w-5 border-2 ${multiple ? 'rounded' : 'rounded-full'} ${
                  checked ? 'border-blue-700 bg-blue-700' : 'border-gray-400 bg-white'
                }`}
              />
              <View className="flex-1 gap-2">
                <QuizImage path={answer.image_path} alt={answer.image_alt} className="h-24" />
                <Text className="text-base text-gray-900">{answer.text}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
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
