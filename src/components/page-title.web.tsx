import { Stack } from 'expo-router';
import Head from 'expo-router/head';

export function PageTitle({ title }: { title: string }) {
  return (
    <>
      <Stack.Screen options={{ title }} />
      <Head>
        <title>{title}</title>
      </Head>
    </>
  );
}
