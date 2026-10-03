import { Pressable, type PressableProps, Text, View } from 'react-native';

// The loading, empty, error and not-found messages the list screens share.

export function StatusMessage({ text }: { text: string }) {
  return <Text className="py-6 text-center text-base text-gray-600">{text}</Text>;
}

export function ErrorState({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <View className="items-center py-6">
      <Text className="text-center text-base text-red-700">{message}</Text>
      <Pressable
        role="button"
        onPress={onRetry}
        className="mt-4 rounded-lg bg-blue-700 px-4 py-2 active:bg-blue-800"
      >
        <Text className="text-base font-semibold text-white">{retryLabel}</Text>
      </Pressable>
    </View>
  );
}

/**
 * A tappable card with a title and an optional description. Used as the child
 * of `<Link asChild>`, which passes it `href` and `onPress`.
 */
export function ListCard({
  title,
  description,
  ...pressableProps
}: { title: string; description: string | null } & PressableProps) {
  return (
    <Pressable
      {...pressableProps}
      className="rounded-xl border border-gray-200 bg-white p-4 hover:bg-gray-50 active:bg-gray-100"
    >
      <Text className="text-lg font-semibold text-gray-900">{title}</Text>
      {description ? <Text className="mt-1 text-base text-gray-600">{description}</Text> : null}
    </Pressable>
  );
}
