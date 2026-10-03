import { Link } from 'expo-router';
import { Pressable, type PressableProps, Text, View } from 'react-native';

// The loading, empty, error and not-found messages the screens share, and
// their button.

export function StatusMessage({ text }: { text: string }) {
  return <Text className="py-6 text-center text-base text-gray-600">{text}</Text>;
}

export function Button({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      disabled={disabled}
      onPress={onPress}
      className={`items-center rounded-lg px-4 py-3 ${
        disabled ? 'bg-gray-300' : 'bg-blue-700 active:bg-blue-800'
      }`}
    >
      <Text className={`text-base font-semibold ${disabled ? 'text-gray-600' : 'text-white'}`}>
        {label}
      </Text>
    </Pressable>
  );
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
      <Text className="mb-4 text-center text-base text-red-700">{message}</Text>
      <Button label={retryLabel} onPress={onRetry} />
    </View>
  );
}

/** A not-found message with a link back to the category list. */
export function NotFoundState({ message, backLabel }: { message: string; backLabel: string }) {
  return (
    <View className="items-center">
      <StatusMessage text={message} />
      <Link href="/" asChild>
        <Pressable>
          <Text className="text-base font-semibold text-blue-700 underline">{backLabel}</Text>
        </Pressable>
      </Link>
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
