import { Modal, Pressable, Text, View } from 'react-native';

type Props = {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * An in-app confirmation for a destructive action. The Modal is the dialog:
 * on the web, react-native-web renders it with role dialog, takes the role
 * and label from these props, keeps the focus inside, closes on Escape
 * (onRequestClose) and puts the focus back on the trigger when it closes.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
      role="alertdialog"
      aria-label={title}
    >
      <View className="flex-1 items-center justify-center bg-black/50 px-4">
        <View accessibilityViewIsModal className="w-full max-w-md gap-4 rounded-xl bg-white p-6">
          <Text role="heading" className="text-xl font-bold text-gray-900">
            {title}
          </Text>
          <Text className="text-base text-gray-700">{message}</Text>
          <View className="flex-row justify-end gap-3">
            <Pressable
              role="button"
              onPress={onCancel}
              className="rounded-lg border border-gray-500 px-4 py-3 active:bg-gray-100"
            >
              <Text className="text-base font-semibold text-gray-900">{cancelLabel}</Text>
            </Pressable>
            <Pressable
              role="button"
              onPress={onConfirm}
              className="rounded-lg bg-red-700 px-4 py-3 active:bg-red-800"
            >
              <Text className="text-base font-semibold text-white">{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
