import { Redirect, Slot } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { AdminHeader, formChanges } from '@/components/admin-header';
import { LeaveGuardProvider } from '@/components/leave-guard';
import { PageTitle } from '@/components/page-title';
import { ErrorState, StatusMessage } from '@/components/status';
import { useIsAdmin } from '@/lib/admin';

// Guards every admin route except the sign-in screen, which sits outside
// this group. The role is read from the database; RLS enforces it anyway,
// so this only decides what the visitor gets to see. The admin header is on
// every state; the breadcrumb only on an admin's screens.
export default function AdminGuardLayout() {
  const { t } = useTranslation();
  const { ready, userId, isAdmin } = useIsAdmin();
  const changes = formChanges.useReports();

  if (ready && userId === null) return <Redirect href="/admin/sign-in" />;
  const allowed = ready && isAdmin.data === true;

  return (
    <LeaveGuardProvider risk={changes.values.some(Boolean) ? 'form' : null}>
      <formChanges.Provider value={changes.reports}>
        <View className="flex-1 bg-gray-50">
          <AdminHeader signOut breadcrumb={allowed} />
          {allowed ? (
            <Slot />
          ) : (
            <ScrollView className="flex-1" contentContainerClassName="px-4 py-8">
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
                  // A signed-in user who isn't an admin may sign out (header) and try another account.
                  <StatusMessage text={t('admin.guard.noAccess')} />
                )}
              </View>
            </ScrollView>
          )}
        </View>
      </formChanges.Provider>
    </LeaveGuardProvider>
  );
}
