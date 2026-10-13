import { Link, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';

import { StatusMessage } from '@/components/status';

// The pieces the admin's list and form screens share.

// A row's controls show a short label ("Bearbeiten") and are named
// "<label>: <row>" (`name`), so the actions of different rows differ for a
// screen reader and the name starts with what a sighted user reads.

/** A row's action: `label` is shown, `name` (default: the label) is announced. */
export function RowAction({
  label,
  name = label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  label: string;
  name?: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={name}
      disabled={disabled}
      onPress={onPress}
      className={`max-w-full rounded-lg border px-3 py-2 ${destructive ? 'border-red-700' : 'border-gray-500'} ${disabled ? 'opacity-50' : ''}`}
    >
      <Text className={`text-base ${destructive ? 'text-red-700' : 'text-gray-900'}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * A row's move-up and move-down buttons at `index` of `count` rows: buttons,
 * so they work by keyboard and screen reader. The first row can't go up and
 * the last can't go down; those stay visible, disabled.
 */
export function MoveActions({
  index,
  count,
  upName,
  downName,
  onMove,
}: {
  index: number;
  count: number;
  upName: string;
  downName: string;
  onMove: (from: number, to: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RowAction
        label={t('admin.rowActions.moveUp')}
        name={upName}
        disabled={index === 0}
        onPress={() => onMove(index, index - 1)}
      />
      <RowAction
        label={t('admin.rowActions.moveDown')}
        name={downName}
        disabled={index === count - 1}
        onPress={() => onMove(index, index + 1)}
      />
    </>
  );
}

/** A row's link to another screen, styled and named like its actions. */
export function RowLink({ label, name, href }: { label: string; name: string; href: Href }) {
  return (
    <Link href={href} asChild>
      <Pressable
        role="link"
        aria-label={name}
        className="max-w-full rounded-lg border border-gray-500 px-3 py-2"
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

/** A row's name; it wraps, also within one long word, inside the card. */
export function RowTitle({ text }: { text: string }) {
  return <Text className="max-w-full text-lg font-semibold text-gray-900">{text}</Text>;
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
