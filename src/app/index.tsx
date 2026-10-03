import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { supabase } from '@/lib/supabase';

type DbStatus = 'loading' | 'ok' | 'error';

export default function HomeScreen() {
  const { t } = useTranslation();
  const [dbStatus, setDbStatus] = useState<DbStatus>('loading');

  useEffect(() => {
    let active = true;
    supabase
      .rpc('health_check')
      .then(
        ({ data, error }) => (!error && data === 'ok' ? 'ok' : 'error'),
        () => 'error' as const,
      )
      .then((status) => {
        if (active) setDbStatus(status);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <View className="flex-1 items-center justify-center bg-white px-4">
      <Text className="text-center text-2xl font-bold text-gray-900">{t('home.title')}</Text>
      <Text className="mt-2 text-center text-base text-gray-600">{t('home.subtitle')}</Text>
      <Text className="mt-6 text-center text-sm text-gray-500">
        {t(`home.dbStatus.${dbStatus}`)}
      </Text>
    </View>
  );
}
