import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import { AdminNotFound } from '@/components/admin-list';
import { PageTitle } from '@/components/page-title';
import { QuizImage } from '@/components/quiz-image';
import { Button, ErrorState, StatusMessage } from '@/components/status';
import {
  adminQuizQuestionsKey,
  fetchPreviewQuestion,
  fetchQuizQuestions,
} from '@/lib/admin-questions';

type PreviewQuestion = NonNullable<Awaited<ReturnType<typeof fetchPreviewQuestion>>>;

// The player's mark for a correct answer; decoration next to the text.
const CORRECT_ICON = '✓';

/**
 * The admin's preview of a quiz, published or not: one question at a time in
 * the player's layout, with the correct answers marked and the explanation
 * shown. Nothing can be picked, and nothing is written: no attempt starts.
 * The solutions come from admin_question() and admin_answers().
 */
export default function QuizPreviewScreen() {
  const { t } = useTranslation();
  const { quizId } = useLocalSearchParams<{ quizId: string }>();
  const list = useQuery({
    queryKey: adminQuizQuestionsKey(quizId),
    queryFn: () => fetchQuizQuestions(quizId),
  });
  const [index, setIndex] = useState(0);
  const questionId = list.data?.questions[index]?.id;
  const question = useQuery({
    queryKey: [...adminQuizQuestionsKey(quizId), 'preview', questionId],
    queryFn: () => fetchPreviewQuestion(questionId!),
    enabled: questionId !== undefined,
  });
  const title = list.data ? list.data.quiz.title : t('admin.preview.marker');

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={title} />
      <View className="mx-auto w-full max-w-2xl gap-4">
        <Text className="rounded-lg bg-amber-100 px-3 py-2 text-base font-semibold text-amber-900">
          {t('admin.preview.marker')}
        </Text>
        {list.isError || question.isError ? (
          <ErrorState
            message={t('admin.preview.error')}
            retryLabel={t('admin.preview.retry')}
            onRetry={() => (list.isError ? list.refetch() : question.refetch())}
            retryDisabled={list.isFetching || question.isFetching}
          />
        ) : list.isPending ? (
          <StatusMessage text={t('admin.preview.loading')} />
        ) : list.data === null ? (
          <AdminNotFound
            message={t('admin.preview.notFound')}
            backLabel={t('admin.preview.back')}
            href="/admin/categories"
          />
        ) : list.data.questions.length === 0 ? (
          <StatusMessage text={t('admin.preview.empty')} />
        ) : question.isPending ? (
          <StatusMessage text={t('admin.preview.loading')} />
        ) : question.data === null ? (
          // Deleted since the list was read.
          <StatusMessage text={t('admin.preview.notFound')} />
        ) : (
          <View>
            <Text role="heading" className="mb-4 text-2xl font-bold text-gray-900">
              {list.data.quiz.title}
            </Text>
            <Text className="mb-2 text-sm font-semibold text-gray-600">
              {t('quiz.progress', { current: index + 1, total: list.data.questions.length })}
            </Text>
            <QuestionPreview question={question.data} />
            {index < list.data.questions.length - 1 ? (
              <Button label={t('quiz.next')} onPress={() => setIndex(index + 1)} />
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function QuestionPreview({ question }: { question: PreviewQuestion }) {
  const { t } = useTranslation();

  return (
    <View className="mb-6">
      <Text role="heading" aria-level={2} className="mb-2 text-xl font-semibold text-gray-900">
        {question.text}
      </Text>
      {question.image_path ? (
        <View className="mb-3">
          <QuizImage path={question.image_path} alt={question.image_alt} className="h-48 w-full" />
        </View>
      ) : null}
      {question.multiple_correct ? (
        <Text className="mb-2 text-base text-gray-600">{t('quiz.multipleHint')}</Text>
      ) : null}
      <View role="list" className="gap-3">
        {question.answers.map((answer) => (
          <View
            key={answer.id}
            role="listitem"
            className={`gap-2 rounded-xl border bg-white p-4 ${
              answer.is_correct ? 'border-green-700' : 'border-gray-200'
            }`}
          >
            <Text className="text-base text-gray-900">{answer.text}</Text>
            <QuizImage path={answer.image_path} alt={answer.image_alt} className="h-24 w-24" />
            {answer.is_correct ? (
              <View className="flex-row items-center gap-1">
                <Text aria-hidden className="text-base font-bold text-green-800">
                  {CORRECT_ICON}
                </Text>
                <Text className="text-sm font-semibold text-green-800">
                  {t('admin.preview.correctAnswer', { answer: answer.text })}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>
      {question.explanation ? (
        <View className="mt-4 rounded-xl bg-gray-100 p-4">
          <Text className="mb-1 text-sm font-semibold text-gray-700">
            {t('quiz.feedback.explanation')}
          </Text>
          <Text className="text-base text-gray-900">{question.explanation}</Text>
        </View>
      ) : null}
    </View>
  );
}
