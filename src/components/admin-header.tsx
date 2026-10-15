import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, usePathname } from 'expo-router';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, useWindowDimensions, View } from 'react-native';

import { NavButton, NavLink } from '@/components/nav-control';
import { adminCategoryKey, fetchAdminCategory } from '@/lib/admin-categories';
import { adminQuizQuestionsKey, fetchQuizQuestions } from '@/lib/admin-questions';
import { createScreenReports } from '@/lib/screen-reports';
import { supabase } from '@/lib/supabase';

/** Whether the shown form differs from its loaded values; its layout asks before leaving. */
export const formChanges = createScreenReports<boolean>();
export const useFormChanged = formChanges.useReport;

/** Below this window width only the parent and the current title show. */
const PHONE_WIDTH = 640;

/**
 * The admin header: "Verwaltung" to the admin start, "Zur App" and, for a
 * signed-in user, "Abmelden"; under it, on an admin's screens, the
 * breadcrumb.
 */
export function AdminHeader({
  signOut = false,
  breadcrumb = false,
}: {
  signOut?: boolean;
  breadcrumb?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View role="banner" className="border-b border-gray-200 bg-white px-2 py-1">
      <View className="mx-auto w-full max-w-2xl">
        <View className="flex-row flex-wrap items-center justify-between">
          <NavLink href="/admin/categories" label={t('nav.admin')} />
          <View className="flex-row flex-wrap">
            <NavLink href="/" label={t('nav.toApp')} />
            {signOut ? <SignOut /> : null}
          </View>
        </View>
        {breadcrumb ? <Breadcrumb /> : null}
      </View>
    </View>
  );
}

/** Signs out and returns to the learner area. */
function SignOut() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: async () => {
      // This device only: a global sign-out would also end the admin's
      // other sessions, which GoTrue's MFA endpoints then refuse.
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
    onSuccess: () => {
      // The learner area starts over with a fresh anonymous session
      // (ensureSession) and must not show what the admin could read.
      queryClient.clear();
      router.replace('/');
    },
  });
  return (
    <NavButton
      label={t('nav.signOut')}
      onPress={() => {
        if (!signOut.isPending) signOut.mutate();
      }}
    />
  );
}

/** A breadcrumb segment; the last one, the current page, has no `href`. */
type Crumb = { label: string; href?: string };

function Breadcrumb() {
  const { t } = useTranslation();
  const crumbs = useCrumbs();
  const phone = useWindowDimensions().width < PHONE_WIDTH;
  // On a phone only "← parent" and the current title, so it never wraps;
  // only "← parent" when the current page has no title (not found). A long
  // name is cut off with an ellipsis, on a desktop too, so it never reaches
  // past the screen.
  const hasCurrent = crumbs.at(-1)?.href === undefined;
  const shown = phone ? crumbs.slice(hasCurrent ? -2 : -1) : crumbs;

  return (
    <View
      role="navigation"
      aria-label={t('nav.breadcrumb.label')}
      className={`flex-row items-center ${phone ? '' : 'flex-wrap'}`}
    >
      {shown.map((crumb, index) => (
        <Fragment key={crumb.href ?? 'current'}>
          {index > 0 && !phone ? (
            <Text aria-hidden className="text-base text-gray-500">
              ›
            </Text>
          ) : null}
          {crumb.href ? (
            <NavLink
              href={crumb.href}
              label={crumb.label}
              sign={phone ? '←' : undefined}
              singleLine
            />
          ) : (
            <Text
              {...{ 'aria-current': 'page' }}
              numberOfLines={1}
              className="shrink px-2 text-base font-semibold text-gray-900"
            >
              {crumb.label}
            </Text>
          )}
        </Fragment>
      ))}
    </View>
  );
}

/**
 * The breadcrumb of the current admin route, from the Design's parents:
 * Kategorien › category › quiz › question / preview / form title. Names come
 * from the admin's reads; while they load, a placeholder, never an id; a name
 * that can't be read leaves its segment out.
 */
function useCrumbs(): Crumb[] {
  const { t } = useTranslation();
  // /admin/<section>/<id>/<rest…>
  const [, section, id, ...rest] = usePathname().split('/').filter(Boolean);
  const quizId = section === 'quizzes' ? id : undefined;
  const quiz = useQuery({
    // The questions list's own read: the quiz and its questions in list order.
    queryKey: adminQuizQuestionsKey(quizId ?? ''),
    queryFn: () => fetchQuizQuestions(quizId!),
    enabled: quizId !== undefined,
  });
  const categoryId =
    section === 'categories' && id !== 'new' && rest[0] !== 'edit'
      ? id
      : quiz.data?.quiz.category_id;
  const category = useQuery({
    // Apart from the edit form's read, which must never start from a cached row.
    queryKey: [...adminCategoryKey(categoryId ?? ''), 'name'],
    queryFn: () => fetchAdminCategory(categoryId!),
    enabled: categoryId !== undefined,
  });

  const loading = t('nav.breadcrumb.loading');
  // A name while it loads is the placeholder; one that can't be read is left out.
  const nameOf = (read: { isPending: boolean }, name: string | undefined) =>
    name ?? (read.isPending ? loading : undefined);
  // Without a category id (the quiz loads, can't be read or doesn't exist)
  // there is nothing to wait for or link to, though the disabled read stays
  // pending; the segment is left out.
  const categoryName = categoryId === undefined ? undefined : nameOf(category, category.data?.name);
  const quizTitle = nameOf(quiz, quiz.data?.quiz.title);
  const questionIndex = quiz.data?.questions.findIndex((question) => question.id === rest[1]);
  const questionLabel =
    questionIndex === undefined
      ? nameOf(quiz, undefined)
      : questionIndex < 0
        ? undefined
        : t('nav.breadcrumb.question', { number: questionIndex + 1 });

  const link = (label: string | undefined, href: string) =>
    label === undefined ? [] : [{ label, href }];
  const categories = link(t('nav.breadcrumb.categories'), '/admin/categories');
  const categoryLink = link(categoryName, `/admin/categories/${categoryId}`);
  const quizLink = link(quizTitle, `/admin/quizzes/${quizId}`);

  // The Design's parents and the current page's title.
  const [parents, current]: [Crumb[], string | undefined] =
    section === 'categories'
      ? id === undefined
        ? [[], t('nav.breadcrumb.categories')]
        : id === 'new'
          ? [categories, t('admin.categories.form.createTitle')]
          : rest[0] === 'edit'
            ? [categories, t('admin.categories.form.editTitle')]
            : rest[0] === 'quizzes'
              ? [[...categories, ...categoryLink], t('admin.quizzes.form.createTitle')]
              : [categories, categoryName]
      : rest[0] === undefined
        ? [[...categories, ...categoryLink], quizTitle]
        : rest[0] === 'edit'
          ? [[...categories, ...categoryLink], t('admin.quizzes.form.editTitle')]
          : [
              [...categories, ...categoryLink, ...quizLink],
              rest[0] === 'preview'
                ? t('nav.breadcrumb.preview')
                : rest[1] === 'new'
                  ? t('admin.questions.form.createTitle')
                  : questionLabel,
            ];
  return current === undefined ? parents : [...parents, { label: current }];
}
