import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/status';
import { supabase } from '@/lib/supabase';

/** Signs out and returns to the learner area. */
export function SignOutButton() {
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
