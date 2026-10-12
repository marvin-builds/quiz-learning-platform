import type { CategoryValues } from '@/lib/category-schema';
import { supabase } from '@/lib/supabase';
import type { TablesInsert } from '@/types/database';

// The admin's reads and writes of categories (#80). RLS lets only an admin
// write, and the column grants only name, description and published; the
// database assigns sort_order (max + 1) on insert.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query keys: the list and each category share the prefix, so one invalidation covers both. */
export const adminCategoriesKey = ['admin', 'categories'] as const;
export const adminCategoryKey = (id: string) => [...adminCategoriesKey, id] as const;

/** Every category, published or not, by sort_order. */
export async function fetchAdminCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description, sort_order, published')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data;
}

/** One category's writable values, or null when it doesn't exist. */
export async function fetchAdminCategory(id: string) {
  if (!UUID.test(id)) return null;
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, description, published')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createCategory(values: CategoryValues) {
  // The generated insert type requires sort_order, which has no column
  // default: the trigger categories_assign_sort_order fills it in, and the
  // column grants refuse it from the client.
  const row = values as TablesInsert<'categories'>;
  const { error } = await supabase.from('categories').insert(row);
  if (error) throw error;
}

export async function updateCategory(id: string, values: Partial<CategoryValues>) {
  const { error } = await supabase.from('categories').update(values).eq('id', id);
  if (error) throw error;
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}
