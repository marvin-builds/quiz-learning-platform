import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Text, type TextInput, View } from 'react-native';

import { Button, ErrorState, StatusMessage } from '@/components/status';
import { TextField } from '@/components/text-field';
import { adminAssuranceKey, codeErrorOf, enrollTotpFactor, verifyTotpCode } from '@/lib/admin';

// The second step of the admin sign-in (#122): enrolling a TOTP factor, or
// entering the code of the verified one. Both end in an aal2 session.

const enrollmentKey = (userId: string) => ['adminEnrollment', userId] as const;

// What survives the step-up: the guard's own reads. Everything else was read
// with the aal1 session and is dropped, as after the password sign-in.
const GUARD_KEYS = new Set<unknown>(['isAdmin', 'adminAssurance', 'adminEnrollment']);

/** An admin without a verified factor: QR code, secret and the code. */
export function AdminEnrollment({ userId }: { userId: string }) {
  const { t } = useTranslation();
  // One factor per visit: never refetched, dropped once the screen is left.
  const enrollment = useQuery({
    queryKey: enrollmentKey(userId),
    queryFn: enrollTotpFactor,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  return (
    <View className="gap-4">
      {enrollment.isPending ? (
        <StatusMessage text={t('admin.mfa.enroll.loading')} />
      ) : enrollment.isError ? (
        <ErrorState
          message={t('admin.mfa.enroll.error')}
          retryLabel={t('admin.guard.retry')}
          onRetry={() => enrollment.refetch()}
          retryDisabled={enrollment.isFetching}
        />
      ) : (
        <>
          <Text role="heading" className="text-2xl font-bold text-gray-900">
            {t('admin.mfa.enroll.title')}
          </Text>
          <Text className="text-base text-gray-700">{t('admin.mfa.enroll.intro')}</Text>
          {/* The label sits on a wrapper: react-native-web would also give its
              hidden <img> the label, which makes two images of one QR code. */}
          <View
            role="img"
            aria-label={t('admin.mfa.enroll.qrAlt')}
            // Native screen readers and the test renderer only see an image
            // as an element with `accessible`; react-native-web ignores it.
            accessible
            className="h-48 w-48 self-center bg-white"
          >
            <Image
              source={{ uri: svgDataUri(enrollment.data.qrCode) }}
              resizeMode="contain"
              className="h-full w-full"
            />
          </View>
          <View className="gap-1">
            <Text className="text-base font-semibold text-gray-900">
              {t('admin.mfa.enroll.secret')}
            </Text>
            <Text selectable className="font-mono text-base text-gray-900">
              {groupSecret(enrollment.data.secret)}
            </Text>
          </View>
          <CodeForm factorId={enrollment.data.factorId} userId={userId} />
        </>
      )}
    </View>
  );
}

/** An admin with a verified factor in an aal1 session: the code. */
export function AdminChallenge({ userId, factorId }: { userId: string; factorId: string }) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <Text role="heading" className="text-2xl font-bold text-gray-900">
        {t('admin.mfa.challenge.title')}
      </Text>
      <Text className="text-base text-gray-700">{t('admin.mfa.challenge.intro')}</Text>
      <CodeForm factorId={factorId} userId={userId} />
    </View>
  );
}

function CodeForm({ factorId, userId }: { factorId: string; userId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const codeInput = useRef<TextInput>(null);
  const verify = useMutation({
    mutationFn: () => verifyTotpCode(factorId, code),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (query) => !GUARD_KEYS.has(query.queryKey[0]) });
      // The guard reads the new level and shows the admin screens.
      await queryClient.invalidateQueries({ queryKey: adminAssuranceKey(userId) });
    },
    // The disabled button dropped the focus; put it back on the field.
    onError: () => codeInput.current?.focus(),
  });
  const submit = () => {
    if (!verify.isPending) verify.mutate();
  };

  return (
    <>
      <TextField
        ref={codeInput}
        id="admin-mfa-code"
        label={t('admin.mfa.code')}
        value={code}
        onChangeText={setCode}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        keyboardType="number-pad"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {verify.isError ? (
        <Text role="alert" className="text-base text-red-700">
          {t(`admin.mfa.errors.${codeErrorOf(verify.error)}`)}
        </Text>
      ) : null}
      <Button
        label={verify.isPending ? t('admin.mfa.submitting') : t('admin.mfa.submit')}
        disabled={verify.isPending}
        onPress={submit}
      />
    </>
  );
}

/** The secret in groups of four, as authenticator apps show it. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}

// supabase-js returns the QR code as `data:image/svg+xml;utf-8,<svg …>`, the
// SVG unencoded; react-native-web puts the URI into a CSS url("…"), where the
// SVG's quotes would end it, so the SVG is percent-encoded.
function svgDataUri(qrCode: string): string {
  const comma = qrCode.indexOf(',');
  return `${qrCode.slice(0, comma)},${encodeURIComponent(qrCode.slice(comma + 1))}`;
}
