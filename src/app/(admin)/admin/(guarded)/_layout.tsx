import { useQuery } from '@tanstack/react-query';
import { Redirect, Slot } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { SignOutButton } from '@/components/sign-out-button';
import { ErrorState, StatusMessage } from '@/components/status';
import { fetchIsAdmin, useAuthSession } from '@/lib/admin';

// Guards every admin route except the sign-in screen, which sits outside
// this group. The role is read from the database; RLS enforces it anyway,
// so this only decides what the visitor gets to see.
export default function AdminGuardLayout() {
  const { t } = useTranslation();
  const { ready, session } = useAuthSession();
  const userId = session && !session.user.is_anonymous ? session.user.id : null;
  // Keyed by user, so a sign-in or sign-out never reuses another user's role.
  const isAdmin = useQuery({
    queryKey: ['isAdmin', userId],
    queryFn: () => fetchIsAdmin(userId!),
    enabled: userId !== null,
  });

  if (ready && userId === null) return <Redirect href="/admin/sign-in" />;
  if (ready && isAdmin.data === true) return <Slot />;

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('admin.dashboard.title')} />
      <View className="mx-auto w-full max-w-2xl">
        {!ready || isAdmin.isPending ? (
          <StatusMessage text={t('admin.guard.loading')} />
        ) : isAdmin.isError ? (
          <ErrorState
            message={t('admin.guard.error')}
            retryLabel={t('admin.guard.retry')}
            onRetry={() => isAdmin.refetch()}
            retryDisabled={isAdmin.isFetching}
          />
        ) : (
          // A signed-in user who isn't an admin may sign out and try another account.
          <View className="gap-4">
            <StatusMessage text={t('admin.guard.noAccess')} />
            <SignOutButton />
          </View>
        )}
      </View>
    </ScrollView>
  );
}
