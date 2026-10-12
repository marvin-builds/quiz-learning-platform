import { Pressable, Text, View } from 'react-native';

/** An on/off field whose label is its accessible name. */
export function SwitchField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable
      role="switch"
      aria-checked={value}
      aria-label={label}
      onPress={() => onChange(!value)}
      className="flex-row items-center justify-between rounded-lg border border-gray-500 bg-white px-3 py-3"
    >
      <Text className="text-base font-semibold text-gray-900">{label}</Text>
      <View
        className={`h-7 w-12 justify-center rounded-full px-1 ${
          value ? 'items-end bg-blue-700' : 'items-start bg-gray-400'
        }`}
      >
        <View className="h-5 w-5 rounded-full bg-white" />
      </View>
    </Pressable>
  );
}
