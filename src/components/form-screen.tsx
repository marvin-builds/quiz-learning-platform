import type { ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { PageTitle } from '@/components/page-title';

/** The frame of the admin's create and edit screens: title and heading. */
export function FormScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="px-4 py-8">
      <PageTitle title={title} />
      <View className="mx-auto w-full max-w-md gap-4">
        <Text role="heading" className="text-2xl font-bold text-gray-900">
          {title}
        </Text>
        {children}
      </View>
    </ScrollView>
  );
}
