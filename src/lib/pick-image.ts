import { launchImageLibraryAsync } from 'expo-image-picker';

/**
 * A file the admin picked, as the device reports it. The picker may leave
 * mimeType, size or fileName out (expo-image-picker, SDK 57).
 */
export type PickedImage = {
  uri: string;
  mimeType?: string;
  size?: number;
  fileName?: string | null;
};

/** Lets the admin pick one image from the device's library; null when cancelled. */
export async function pickImage(): Promise<PickedImage | null> {
  const result = await launchImageLibraryAsync({ mediaTypes: ['images'] });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    mimeType: asset.mimeType ?? undefined,
    size: asset.fileSize ?? undefined,
    fileName: asset.fileName,
  };
}
