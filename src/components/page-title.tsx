import { Stack } from 'expo-router';

// The screen's title for the navigator. The web variant also sets the
// document title, which expo-router doesn't do on its own.
export function PageTitle({ title }: { title: string }) {
  return <Stack.Screen options={{ title }} />;
}
