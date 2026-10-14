import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';

import { saveQuestion } from '@/lib/admin-questions';
import { adminKey } from '@/lib/admin-quizzes';
import type { QuestionWithAnswersValues } from '@/lib/question-schema';

/** The search parameter that makes the question list tell the admin an image is still online. */
export const IMAGES_LEFT_PARAM = 'imagesLeft';

/**
 * Saves a question from its form (see saveQuestion) and returns to the
 * quiz's question list once it went through. When removing an image object
 * failed, the admin is told: on the list after a done save (a search
 * parameter), else beside the form's failure (`imagesLeft`).
 */
export function useSaveQuestion(
  quizId: string,
  questionId: string | null,
  storedPaths: () => string[] = () => [],
) {
  const queryClient = useQueryClient();
  const [imagesLeft, setImagesLeft] = useState(false);
  const mutation = useMutation({
    mutationFn: async (values: QuestionWithAnswersValues) => {
      setImagesLeft(false);
      let left = false;
      try {
        await saveQuestion(quizId, questionId, values, storedPaths(), () => {
          left = true;
        });
      } catch (error) {
        setImagesLeft(left);
        throw error;
      }
      return left;
    },
    onSuccess: async (left) => {
      await queryClient.invalidateQueries({ queryKey: adminKey });
      router.replace(
        left ? `/admin/quizzes/${quizId}?${IMAGES_LEFT_PARAM}=1` : `/admin/quizzes/${quizId}`,
      );
    },
  });
  return { mutation, imagesLeft };
}
