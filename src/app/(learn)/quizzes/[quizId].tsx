import type { PostgrestError } from '@supabase/supabase-js';
import { type UseMutationOptions, useMutation, useQuery } from '@tanstack/react-query';
import { Link, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { ErrorState, StatusMessage } from '@/components/status';
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
      <PageTitle title={quiz.data?.title ?? t('categories.title')} />
      <View className="mx-auto w-full max-w-2xl">
        {quiz.isPending ? (
          <StatusMessage text={t('quiz.loading')} />
        ) : quiz.isError ? (
          <ErrorState
            message={t('quiz.error')}
            retryLabel={t('quiz.retry')}
            onRetry={() => quiz.refetch()}
          />
        ) : quiz.data === null ? (
          <NotFound />
        ) : (
          <QuizContent quiz={quiz.data} />
        )}
      </View>
    </ScrollView>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <View className="items-center">
      <StatusMessage text={t('quiz.notFound')} />
      <Link href="/" asChild>
        <Pressable>
          <Text className="text-base font-semibold text-blue-700 underline">
            {t('quiz.backToCategories')}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
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
          {quiz.questionCount === 0 ? (
            <StatusMessage text={t('quiz.noQuestions')} />
          ) : start.isError && (start.error as PostgrestError).message === NOT_AVAILABLE ? (
            <StatusMessage text={t('quiz.unavailable')} />
          ) : start.isError ? (
            <ErrorState
              message={t('quiz.startError')}
              retryLabel={t('quiz.retry')}
              onRetry={() => start.run()}
            />
          ) : (
            <PrimaryButton
              label={t('quiz.start')}
              disabled={start.busy}
              onPress={() => start.run()}
            />
          )}
        </>
      )}
    </>
  );
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
  // Item 9 shows the recorded result (submit.data) before moving on.
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
    setPicks((current) =>
      !question.multiple_correct
        ? [answerId]
        : current.includes(answerId)
          ? current.filter((id) => id !== answerId)
          : [...current, answerId],
    );

  return (
    <View>
      <Text className="mb-2 text-sm font-semibold text-gray-600">
        {t('quiz.progress', { current: index + 1, total: questions.data.length })}
      </Text>
      <QuestionView question={question} picks={picks} disabled={submit.busy} onPick={pick} />
      {submit.isError ? (
        <ErrorState message={t('quiz.submitError')} retryLabel={t('quiz.retry')} onRetry={send} />
      ) : (
        <PrimaryButton
          label={t('quiz.submit')}
          disabled={picks.length === 0 || submit.busy}
          onPress={send}
        />
      )}
    </View>
  );
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
  const multiple = question.multiple_correct;

  return (
    <View className="mb-6">
      <Text nativeID={labelId} className="mb-2 text-xl font-semibold text-gray-900">
        {question.text}
      </Text>
      {multiple ? (
        <Text className="mb-2 text-base text-gray-600">{t('quiz.multipleHint')}</Text>
      ) : null}
      <View role={multiple ? 'group' : 'radiogroup'} aria-labelledby={labelId} className="gap-3">
        {question.answers.map((answer) => {
          const checked = picks.includes(answer.id);
          return (
            <Pressable
              key={answer.id}
              role={multiple ? 'checkbox' : 'radio'}
              aria-checked={checked}
              disabled={disabled}
              onPress={() => onPick(answer.id)}
              className={`flex-row items-center rounded-xl border bg-white p-4 hover:bg-gray-50 ${
                checked ? 'border-blue-700' : 'border-gray-200'
              }`}
            >
              <View
                className={`mr-3 h-5 w-5 border-2 ${multiple ? 'rounded' : 'rounded-full'} ${
                  checked ? 'border-blue-700 bg-blue-700' : 'border-gray-400 bg-white'
                }`}
              />
              <Text className="flex-1 text-base text-gray-900">{answer.text}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A mutation that is busy from the press on: TanStack Query reports
 * isPending only on its next notification, so a second press before that
 * would send the request twice.
 */
function useGuardedMutation<TData, TVariables = void>(
  options: Pick<UseMutationOptions<TData, Error, TVariables>, 'mutationFn' | 'onSuccess'>,
) {
  const [pressed, setPressed] = useState(false);
  const mutation = useMutation({ ...options, onSettled: () => setPressed(false) });
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

function PrimaryButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      disabled={disabled}
      aria-disabled={disabled}
      onPress={onPress}
      className={`items-center rounded-lg px-4 py-3 ${
        disabled ? 'bg-gray-300' : 'bg-blue-700 active:bg-blue-800'
      }`}
    >
      <Text className={`text-base font-semibold ${disabled ? 'text-gray-600' : 'text-white'}`}>
        {label}
      </Text>
    </Pressable>
  );
}
