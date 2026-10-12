import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, View } from 'react-native';

import { ErrorText, RowAction } from '@/components/admin-list';
import { TextField } from '@/components/text-field';
import { imageTypeOfName, newImageName, quizImageUrl } from '@/lib/images';
import { pickImage, releaseImage } from '@/lib/pick-image';
import { imageFileSchema, type ImageFile } from '@/lib/question-schema';

// The file checks' messages (imageFileSchema) are keys of admin.questions.form.errors.
type PickErrorKey = `admin.questions.form.errors.${'imageTooLarge' | 'imageType'}`;

type Labels = { pick: string; replace: string; remove: string; alt: string; preview: string };

/**
 * The image of a question or an answer in the question form: pick one from
 * the device (checked against the bucket's limits at once; a refused file
 * is never taken), preview it, replace or remove it, and write its alt text.
 * A taken file gets a new object name; the upload happens on save, which
 * gives each attempt a fresh name (saveQuestion). A replaced or removed
 * file is released (on the web, its object URL revoked).
 */
export function ImageField({
  id,
  labels,
  path,
  file,
  alt,
  altError,
  onPicked,
  onRemove,
  onAltChange,
}: {
  id: string;
  labels: Labels;
  path: string | null;
  file: ImageFile | null;
  alt: string | null;
  /** The translated message of the form's alt text check, or undefined. */
  altError?: string;
  onPicked: (path: string, file: ImageFile) => void;
  onRemove: () => void;
  onAltChange: (alt: string) => void;
}) {
  const { t } = useTranslation();
  const [pickError, setPickError] = useState<string | null>(null);

  // Synchronous up to pickImage(), so the web build's file input opens
  // within the press.
  const pick = async () => {
    const picked = await pickImage();
    if (!picked) return;
    const mimeType =
      picked.mimeType || imageTypeOfName(picked.fileName) || imageTypeOfName(picked.uri) || '';
    const parsed = imageFileSchema.safeParse({
      uri: picked.uri,
      mimeType,
      ...(picked.size === undefined ? {} : { size: picked.size }),
    });
    if (!parsed.success) {
      setPickError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setPickError(null);
    if (file) releaseImage(file.uri);
    onPicked(newImageName(mimeType), parsed.data);
  };

  return (
    <View className="gap-2">
      {path ? (
        <Image
          source={{ uri: file ? file.uri : quizImageUrl(path) }}
          role="img"
          aria-label={labels.preview}
          alt={labels.preview}
          // Native screen readers and the test renderer only see an image as
          // an element with `accessible`; react-native-web ignores it.
          accessible
          resizeMode="contain"
          className="h-40 w-full rounded-lg bg-gray-100"
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <RowAction label={path ? labels.replace : labels.pick} onPress={() => void pick()} />
        {path ? (
          <RowAction
            label={labels.remove}
            onPress={() => {
              setPickError(null);
              if (file) releaseImage(file.uri);
              onRemove();
            }}
            destructive
          />
        ) : null}
      </View>
      {pickError ? <ErrorText text={t(pickError as PickErrorKey)} /> : null}
      {path ? (
        <TextField id={id} label={labels.alt} value={alt ?? ''} onChangeText={onAltChange} />
      ) : null}
      {altError ? <ErrorText text={altError} /> : null}
    </View>
  );
}
