import { useState } from 'react';
import { Image, Text } from 'react-native';

import { quizImageUrl } from '@/lib/images';

/**
 * The image of a question or an answer, if it has one, labelled with its alt
 * text (the database requires one with every image). A fixed height keeps it
 * from collapsing on the web, where the picture is a CSS background. If it
 * can't be loaded, its alt text takes its place, so the question keeps its
 * content and layout.
 */
export function QuizImage({
  path,
  alt,
  className,
}: {
  path: string | null;
  alt: string | null;
  className: string;
}) {
  // The path that failed, not a flag: the player reuses this component for
  // the next question's image, which deserves its own try.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  if (!path || !alt) return null;
  if (failedPath === path) return <Text className="text-base italic text-gray-600">{alt}</Text>;
  return (
    <Image
      source={{ uri: quizImageUrl(path) }}
      role="img"
      aria-label={alt}
      alt={alt}
      // Native screen readers and the test renderer only see an image as an
      // element with `accessible`; react-native-web ignores it.
      accessible
      resizeMode="contain"
      onError={() => setFailedPath(path)}
      className={className}
    />
  );
}
