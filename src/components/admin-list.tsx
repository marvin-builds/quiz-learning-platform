import { Link, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { StatusMessage } from '@/components/status';

// The pieces the admin's list and form screens share.

/** A row's action, named with the row so the actions of different rows differ. */
export function RowAction({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-lg border px-3 py-2 ${destructive ? 'border-red-700' : 'border-gray-500'}`}
    >
      <Text className={`text-base ${destructive ? 'text-red-700' : 'text-gray-900'}`}>{label}</Text>
    </Pressable>
  );
}

/** A row's link to another screen, styled like its actions. */
export function RowLink({ label, href }: { label: string; href: Href }) {
  return (
    <Link href={href} asChild>
      <Pressable
        role="link"
        aria-label={label}
        className="rounded-lg border border-gray-500 px-3 py-2"
      >
        <Text className="text-base text-gray-900">{label}</Text>
      </Pressable>
    </Link>
  );
}

/** The list's main link, e.g. to the create form. */
export function PrimaryLink({ label, href }: { label: string; href: Href }) {
  return (
    <Link href={href} asChild>
      <Pressable role="link" className="items-center rounded-lg bg-blue-700 px-4 py-3">
        <Text className="text-base font-semibold text-white">{label}</Text>
      </Pressable>
    </Link>
  );
}

/** Whether a row is published, as a badge. */
export function PublishedBadge({ published, label }: { published: boolean; label: string }) {
  return (
    <Text
      className={`rounded-full px-3 py-1 text-sm font-semibold ${
        published ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-800'
      }`}
    >
      {label}
    </Text>
  );
}

export function ErrorText({ text }: { text: string }) {
  return (
    <Text role="alert" className="text-base text-red-700">
      {text}
    </Text>
  );
}

/** A not-found message with a link back to where the admin can go on. */
export function AdminNotFound({
  message,
  backLabel,
  href,
}: {
  message: string;
  backLabel: string;
  href: Href;
}) {
  return (
    <View className="items-center">
      <StatusMessage text={message} />
      <Link href={href} asChild>
        <Pressable role="link">
          <Text className="text-base font-semibold text-blue-700 underline">{backLabel}</Text>
        </Pressable>
      </Link>
    </View>
  );
}
