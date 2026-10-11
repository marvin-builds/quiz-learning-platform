import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { Button, ListCard, StatusMessage } from '@/components/status';
import { fetchIsAdmin, useAuthSession } from '@/lib/admin';
import { supabase } from '@/lib/supabase';

export default function AdminDashboardScreen() {
  const { t } = useTranslation();
  const { ready, session } = useAuthSession();
  const userId = session && !session.user.is_anonymous ? session.user.id : null;
  // Keyed by user, so a sign-in or sign-out never reuses another user's role.
  const isAdmin = useQuery({
    queryKey: ['isAdmin', userId],
    queryFn: () => fetchIsAdmin(userId!),
    enabled: userId !== null,
    staleTime: 0,
  });

  let content;
  if (!ready) {
    content = <StatusMessage text={t('admin.guard.loading')} />;
  } else if (userId === null) {
    return <Redirect href="/admin/sign-in" />;
  } else if (isAdmin.isPending) {
    content = <StatusMessage text={t('admin.guard.loading')} />;
  } else if (isAdmin.isError) {
    content = <StatusMessage text={t('admin.guard.error')} />;
  } else if (!isAdmin.data) {
    content = <NoAccess />;
  } else {
    content = <Dashboard />;
  }

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('admin.dashboard.title')} />
      <View className="mx-auto w-full max-w-2xl">{content}</View>
    </ScrollView>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  return (
    <View className="gap-6">
      <Text role="heading" className="text-2xl font-bold text-gray-900">
        {t('admin.dashboard.title')}
      </Text>
      <Link href="/admin/categories" asChild>
        <ListCard title={t('admin.dashboard.categories')} description={null} />
      </Link>
      <SignOutButton />
    </View>
  );
}

/** A signed-in user who isn't an admin: they may sign out and try another account. */
function NoAccess() {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <StatusMessage text={t('admin.guard.noAccess')} />
      <SignOutButton />
    </View>
  );
}

function SignOutButton() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    onSuccess: () => {
      // The learner area starts over with a fresh anonymous session
      // (ensureSession) and must not show what the admin could read.
      queryClient.clear();
      router.replace('/');
    },
  });

  return (
    <Button
      label={t('admin.dashboard.signOut')}
      disabled={signOut.isPending}
      onPress={() => signOut.mutate()}
    />
  );
}
