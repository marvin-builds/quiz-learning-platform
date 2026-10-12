import type { ComponentProps, Ref } from 'react';
import { Text, TextInput, View } from 'react-native';

/** A text input with a visible label that is also its accessible name. */
export function TextField({
  id,
  label,
  ...inputProps
}: { id: string; label: string; ref?: Ref<TextInput> } & Omit<
  ComponentProps<typeof TextInput>,
  'aria-labelledby' | 'className'
>) {
  return (
    <View className="gap-1">
      <Text nativeID={id} className="text-base font-semibold text-gray-900">
        {label}
      </Text>
      <TextInput
        {...inputProps}
        aria-labelledby={id}
        className="rounded-lg border border-gray-500 bg-white px-3 py-2 text-base text-gray-900"
      />
    </View>
  );
}
