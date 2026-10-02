import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function HomeScreen() {
  const { t } = useTranslation();

  return (
    <View className="flex-1 items-center justify-center bg-white px-4">
      <Text className="text-center text-2xl font-bold text-gray-900">{t('home.title')}</Text>
      <Text className="mt-2 text-center text-base text-gray-600">{t('home.subtitle')}</Text>
    </View>
  );
}
