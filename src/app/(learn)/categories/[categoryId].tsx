import { useQuery } from '@tanstack/react-query';
import { type Href, Link, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { ErrorState, ListCard, StatusMessage } from '@/components/status';
import { fetchCategoryWithQuizzes } from '@/lib/content';

type Category = NonNullable<Awaited<ReturnType<typeof fetchCategoryWithQuizzes>>>;

export default function CategoryScreen() {
  const { t } = useTranslation();
  const { categoryId } = useLocalSearchParams<{ categoryId: string }>();
  const category = useQuery({
    queryKey: ['category', categoryId],
    queryFn: () => fetchCategoryWithQuizzes(categoryId),
  });

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={category.data?.name ?? t('categories.title')} />
      <View className="mx-auto w-full max-w-2xl">
        {category.isPending ? (
          <StatusMessage text={t('category.loading')} />
        ) : category.isError ? (
          <ErrorState
            message={t('category.error')}
            retryLabel={t('category.retry')}
            onRetry={() => category.refetch()}
          />
        ) : category.data === null ? (
          <NotFound />
        ) : (
          <CategoryContent category={category.data} />
        )}
      </View>
    </ScrollView>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <View className="items-center">
      <StatusMessage text={t('category.notFound')} />
      <Link href="/" asChild>
        <Pressable>
          <Text className="text-base font-semibold text-blue-700 underline">
            {t('category.backToCategories')}
          </Text>
        </Pressable>
      </Link>
    </View>
  );
}

function CategoryContent({ category }: { category: Category }) {
  const { t } = useTranslation();
  return (
    <>
      <Text role="heading" className="mb-2 text-2xl font-bold text-gray-900">
        {category.name}
      </Text>
      {category.description ? (
        <Text className="mb-6 text-base text-gray-600">{category.description}</Text>
      ) : null}
      {category.quizzes.length === 0 ? (
        <StatusMessage text={t('category.empty')} />
      ) : (
        <View className="gap-3">
          {category.quizzes.map((quiz) => (
            // TODO(#51): drop the cast once the quiz screen exists for typed routes.
            <Link key={quiz.id} href={`/quizzes/${quiz.id}` as Href} asChild>
              <ListCard title={quiz.title} description={quiz.description} />
            </Link>
          ))}
        </View>
      )}
    </>
  );
}
