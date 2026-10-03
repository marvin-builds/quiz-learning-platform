import { useQuery } from '@tanstack/react-query';
import { Link, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { ErrorState, ListCard, NotFoundState, StatusMessage } from '@/components/status';
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
          <NotFoundState
            message={t('category.notFound')}
            backLabel={t('category.backToCategories')}
          />
        ) : (
          <CategoryContent category={category.data} />
        )}
      </View>
    </ScrollView>
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
            <Link key={quiz.id} href={`/quizzes/${quiz.id}`} asChild>
              <ListCard title={quiz.title} description={quiz.description} />
            </Link>
          ))}
        </View>
      )}
    </>
  );
}
