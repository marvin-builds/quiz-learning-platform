import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { ErrorState, ListCard, StatusMessage } from '@/components/status';
import { fetchCategories } from '@/lib/content';

export default function CategoriesScreen() {
  const { t } = useTranslation();
  const categories = useQuery({ queryKey: ['categories'], queryFn: fetchCategories });

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('categories.title')} />
      <View className="mx-auto w-full max-w-2xl">
        <Text role="heading" className="mb-6 text-2xl font-bold text-gray-900">
          {t('home.title')}
        </Text>
        {categories.isPending ? (
          <StatusMessage text={t('categories.loading')} />
        ) : categories.isError ? (
          <ErrorState
            message={t('categories.error')}
            retryLabel={t('categories.retry')}
            onRetry={() => categories.refetch()}
          />
        ) : categories.data.length === 0 ? (
          <StatusMessage text={t('categories.empty')} />
        ) : (
          <View className="gap-3">
            {categories.data.map((category) => (
              <Link key={category.id} href={`/categories/${category.id}`} asChild>
                <ListCard title={category.name} description={category.description} />
              </Link>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
