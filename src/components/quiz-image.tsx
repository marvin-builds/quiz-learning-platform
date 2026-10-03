import { useState } from 'react';
import { Image, Text } from 'react-native';

import { quizImageUrl } from '@/lib/images';

/**
 * The image of a question or an answer, labelled with its alt text. A fixed
 * height keeps it from collapsing on the web, where the picture is a CSS
 * background. If it can't be loaded, its alt text takes its place, so the
 * question keeps its content and layout.
 */
export function QuizImage({
  path,
  alt,
  className,
}: {
  path: string;
  alt: string;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Text className="text-base italic text-gray-600">{alt}</Text>;
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
      onError={() => setFailed(true)}
      className={`w-full ${className}`}
    />
  );
}
