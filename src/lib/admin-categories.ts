import { isUuid, requireWritten } from '@/lib/admin-rows';
import type { CategoryValues } from '@/lib/category-schema';
import { supabase } from '@/lib/supabase';
import type { TablesInsert } from '@/types/database';

// The admin's reads and writes of categories (#80). RLS lets only an admin
// write, and the column grants only name, description and published; the
// database assigns sort_order (max + 1) on insert.

/** Query keys: the list and each category share the prefix, so one invalidation covers both. */
export const adminCategoriesKey = ['admin', 'categories'] as const;
export const adminCategoryKey = (id: string) => [...adminCategoriesKey, id] as const;

/** Every category, published or not, by sort_order and then id, like the learner's list. */
export async function fetchAdminCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description, sort_order, published')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;
  return data;
}

/** One category's writable values, or null when it doesn't exist. */
export async function fetchAdminCategory(id: string) {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description, published')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createCategory(values: CategoryValues) {
  // Checked against the generated insert type without sort_order, which the
  // trigger categories_assign_sort_order fills in (the column grants refuse
  // it from the client). The generated type still requires it because the
  // column has no default, so only that one property is cast away.
  const row: Omit<TablesInsert<'categories'>, 'sort_order'> = values;
  const { error } = await supabase.from('categories').insert(row as TablesInsert<'categories'>);
  if (error) throw error;
}

export async function updateCategory(id: string, values: Partial<CategoryValues>) {
  const { data, error } = await supabase
    .from('categories')
    .update(values)
    .eq('id', id)
    .select('id');
  if (error) throw error;
  requireWritten(data);
}

export async function deleteCategory(id: string) {
  const { data, error } = await supabase.from('categories').delete().eq('id', id).select('id');
  if (error) throw error;
  requireWritten(data);
}

/**
 * Puts the categories in the order of `ids`, which must name every category
 * once: reorder_categories() refuses a stale or partial list and changes
 * nothing.
 */
export async function reorderCategories(ids: string[]) {
  const { error } = await supabase.rpc('reorder_categories', { category_ids: ids });
  if (error) throw error;
}
