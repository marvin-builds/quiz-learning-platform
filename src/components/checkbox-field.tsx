import { Pressable, Text, View } from 'react-native';

/** A checkbox whose label is its accessible name. */
export function CheckboxField({
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
      role="checkbox"
      aria-checked={value}
      aria-label={label}
      onPress={() => onChange(!value)}
      className="flex-row items-center gap-2 py-2"
    >
      <View
        className={`h-6 w-6 items-center justify-center rounded border-2 ${
          value ? 'border-blue-700 bg-blue-700' : 'border-gray-500 bg-white'
        }`}
      >
        {value ? (
          <View className="-mt-0.5 h-3 w-1.5 rotate-45 border-b-2 border-r-2 border-white" />
        ) : null}
      </View>
      <Text className="text-base text-gray-900">{label}</Text>
    </Pressable>
  );
}
