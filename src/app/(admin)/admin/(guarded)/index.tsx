import { Redirect } from 'expo-router';

// The admin start is the category list; /admin has no page of its own.
export default function AdminStart() {
  return <Redirect href="/admin/categories" />;
}
