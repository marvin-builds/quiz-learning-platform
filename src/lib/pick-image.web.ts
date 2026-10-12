import { IMAGE_TYPES } from '@/lib/images';
import type { PickedImage } from '@/lib/pick-image';

export type { PickedImage } from '@/lib/pick-image';

/**
 * The web build's picker: a file input of its own that accepts exactly the
 * bucket's types (expo-image-picker's accepts every image). Opened from the
 * pick button's press, so the browser sees the user's gesture.
 */
export function pickImage(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = Object.keys(IMAGE_TYPES).join(',');
    input.style.display = 'none';
    const done = (picked: PickedImage | null) => {
      input.remove();
      resolve(picked);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      done(
        file
          ? {
              uri: URL.createObjectURL(file),
              mimeType: file.type || undefined,
              size: file.size,
              fileName: file.name,
            }
          : null,
      );
    });
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}
