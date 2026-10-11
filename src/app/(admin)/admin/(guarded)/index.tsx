import { type Href, Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { SignOutButton } from '@/components/sign-out-button';
import { ListCard } from '@/components/status';

export default function AdminDashboardScreen() {
  const { t } = useTranslation();

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('admin.dashboard.title')} />
      <View className="mx-auto w-full max-w-2xl gap-6">
        <Text role="heading" className="text-2xl font-bold text-gray-900">
          {t('admin.dashboard.title')}
        </Text>
        {/* The categories screen comes with #80; drop the cast then. */}
        <Link href={'/admin/categories' as Href} asChild>
          <ListCard title={t('admin.dashboard.categories')} description={null} />
        </Link>
        <SignOutButton />
      </View>
    </ScrollView>
  );
}
