import { isRuleViolation, isUuid, requireWritten } from '@/lib/admin-rows';
import { adminKey, adminQuizKey, fetchAdminQuiz } from '@/lib/admin-quizzes';
import { ImageUploadError, newImageName, removeImages, uploadImage } from '@/lib/images';
import type { ImageFile, QuestionWithAnswersValues } from '@/lib/question-schema';
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';

// The admin's reads and writes of questions (#81) and their answers (#82).
// questions.explanation and answers.is_correct are solution columns that no
// role may select, admins included: the edit form reads them through the
// admin-only functions admin_question() and admin_answers(), and saves go
// through save_question(), which returns only the question's id. Images
// (#83) are read through the columns every role may select, and their
// objects uploaded before and removed after save_question().

export const adminQuestionKey = (id: string) => [...adminKey, 'questions', id] as const;
export const adminAnswersKey = (questionId: string) =>
  [...adminQuestionKey(questionId), 'answers'] as const;
// Under the quiz's key, so a change to the quiz refreshes the list too.
export const adminQuizQuestionsKey = (quizId: string) =>
  [...adminQuizKey(quizId), 'questions'] as const;

/** A quiz and its questions by sort_order, without explanations; null when the quiz doesn't exist. */
export async function fetchQuizQuestions(quizId: string) {
  if (!isUuid(quizId)) return null;
  const [quiz, questions] = await Promise.all([
    fetchAdminQuiz(quizId),
    supabase
      .from('questions')
      .select('id, text, sort_order')
      .eq('quiz_id', quizId)
      .order('sort_order', { ascending: true }),
  ]);
  if (questions.error) throw questions.error;
  return quiz && { quiz, questions: questions.data };
}

/**
 * One question with its explanation, through admin_question(), and its
 * image; null when it doesn't exist.
 */
export async function fetchAdminQuestion(id: string) {
  if (!isUuid(id)) return null;
  const [solution, image] = await Promise.all([
    supabase.rpc('admin_question', { question_id: id }),
    supabase.from('questions').select('image_path, image_alt').eq('id', id).maybeSingle(),
  ]);
  if (solution.error) throw solution.error;
  if (image.error) throw image.error;
  const [question] = solution.data;
  if (!question) return null;
  // The generated type misses that a question may have no explanation.
  return {
    ...question,
    explanation: question.explanation as string | null,
    image_path: image.data?.image_path ?? null,
    image_alt: image.data?.image_alt ?? null,
  };
}

/** A question's answers with is_correct, through admin_answers(), and their images, by sort_order. */
export async function fetchAdminAnswers(questionId: string) {
  const [solutions, images] = await Promise.all([
    supabase.rpc('admin_answers', { question_id: questionId }),
    supabase.from('answers').select('id, image_path, image_alt').eq('question_id', questionId),
  ]);
  if (solutions.error) throw solutions.error;
  if (images.error) throw images.error;
  return solutions.data.map((answer) => {
    const image = images.data.find((row) => row.id === answer.id);
    return {
      ...answer,
      image_path: image?.image_path ?? null,
      image_alt: image?.image_alt ?? null,
    };
  });
}

/**
 * Saves a question with its answers in one transaction through
 * save_question(): creates it in the quiz when questionId is null, else
 * updates it. Answers with an id are updated, without one inserted, and the
 * question's answers left out are deleted. Returns nothing that holds a
 * solution: only the question's id.
 *
 * Images: every newly picked file is uploaded first, under a name new to
 * this attempt (a failed attempt whose clean-up failed too leaves its object
 * behind, and Storage never overwrites one); if one upload fails
 * (ImageUploadError) or the save does, the objects uploaded for it are
 * removed again and the stored ones stay. Once the save went through, the
 * objects of `storedPaths` (the images the question and its answers had)
 * that no longer are named are removed, best effort.
 */
export async function saveQuestion(
  quizId: string,
  questionId: string | null,
  values: QuestionWithAnswersValues,
  storedPaths: string[] = [],
) {
  // A new file gets a fresh name per attempt; a stored image keeps its own.
  const named = <T extends { image_path: string | null; image_file: ImageFile | null }>(
    image: T,
  ): T =>
    image.image_path !== null && image.image_file !== null
      ? { ...image, image_path: newImageName(image.image_file.mimeType) }
      : image;
  const namedQuestion = named(values);
  const namedAnswers = values.answers.map(named);
  const { image_file: _file, answers: _answers, ...question } = namedQuestion;
  const images = [namedQuestion, ...namedAnswers];
  const uploaded: string[] = [];
  try {
    for (const { image_path: path, image_file: file } of images) {
      if (path === null || file === null) continue;
      await uploadImage(path, file);
      uploaded.push(path);
    }
    // The generated types miss that question_id and explanation may be null.
    const args = {
      quiz_id: quizId,
      question_id: questionId,
      ...question,
      answers: namedAnswers.map(({ image_file: _file, ...answer }) => answer),
    };
    const { error } = await supabase.rpc(
      'save_question',
      args as Database['public']['Functions']['save_question']['Args'],
    );
    if (error) throw error;
  } catch (error) {
    await removeImages(uploaded);
    throw error;
  }
  const kept = new Set(images.map((image) => image.image_path));
  await removeImages(storedPaths.filter((path) => !kept.has(path)));
}

/**
 * The message key for a failed save: a refused upload, a rule the database
 * refused (23514), or any other failure worth retrying.
 */
export const saveFailureKey = (error: unknown) =>
  error instanceof ImageUploadError
    ? 'admin.questions.form.errors.imageUpload'
    : isRuleViolation(error)
      ? 'admin.questions.form.errors.rules'
      : 'admin.questions.form.errors.save';

export async function deleteQuestion(id: string) {
  const { data, error } = await supabase.from('questions').delete().eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}
