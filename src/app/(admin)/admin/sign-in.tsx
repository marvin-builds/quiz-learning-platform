import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { type ComponentProps, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { PageTitle } from '@/components/page-title';
import { Button } from '@/components/status';
import { signInErrorOf } from '@/lib/admin';
import { supabase } from '@/lib/supabase';

export default function AdminSignInScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    },
    onSuccess: () => {
      // Content read as the previous user (e.g. anonymous) must not linger.
      queryClient.clear();
      router.replace('/admin');
    },
  });

  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={t('admin.signIn.title')} />
      <View className="mx-auto w-full max-w-md gap-4">
        <Text role="heading" className="text-2xl font-bold text-gray-900">
          {t('admin.signIn.title')}
        </Text>
        <Field
          id="admin-sign-in-email"
          label={t('admin.signIn.email')}
          value={email}
          onChangeText={setEmail}
          autoComplete="email"
          keyboardType="email-address"
        />
        <Field
          id="admin-sign-in-password"
          label={t('admin.signIn.password')}
          value={password}
          onChangeText={setPassword}
          autoComplete="current-password"
          secureTextEntry
        />
        {signIn.isError ? (
          <Text role="alert" className="text-base text-red-700">
            {t(`admin.signIn.errors.${signInErrorOf(signIn.error)}`)}
          </Text>
        ) : null}
        <Button
          label={signIn.isPending ? t('admin.signIn.submitting') : t('admin.signIn.submit')}
          disabled={signIn.isPending}
          onPress={() => signIn.mutate()}
        />
      </View>
    </ScrollView>
  );
}

/** A text input with a visible label that is also its accessible name. */
function Field({
  id,
  label,
  ...inputProps
}: { id: string; label: string } & Pick<
  ComponentProps<typeof TextInput>,
  'value' | 'onChangeText' | 'autoComplete' | 'keyboardType' | 'secureTextEntry'
>) {
  return (
    <View className="gap-1">
      <Text nativeID={id} className="text-base font-semibold text-gray-900">
        {label}
      </Text>
      <TextInput
        {...inputProps}
        aria-labelledby={id}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-gray-500 bg-white px-3 py-2 text-base text-gray-900"
      />
    </View>
  );
}
