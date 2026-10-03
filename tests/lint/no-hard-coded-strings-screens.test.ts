/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const RULE = 'i18next/no-literal-string';

// ESLint 9 loads its config with a dynamic import, which Jest's module VM does
// not support, so the project's real ESLint CLI runs in a child process.
function lintScreen(source: string): string[] {
  const eslintBin = path.join(process.cwd(), 'node_modules', '.bin', 'eslint');
  const { stdout, stderr } = spawnSync(
    eslintBin,
    ['--stdin', '--stdin-filename', 'src/app/example.tsx', '--format', 'json'],
    { input: source, encoding: 'utf8' },
  );
  if (!stdout) {
    throw new Error(`ESLint produced no output: ${stderr}`);
  }
  const [result] = JSON.parse(stdout) as {
    messages: { ruleId: string | null; message: string }[];
  }[];
  return result.messages.map((message) => message.ruleId ?? message.message);
}

function countRule(ruleIds: string[]): number {
  return ruleIds.filter((ruleId) => ruleId === RULE).length;
}

describe('lint rule against hard-coded UI strings in screens', () => {
  it('rejects a hard-coded screen title in Stack.Screen options', () => {
    const source = `import { Stack } from 'expo-router';

export default function Example() {
  return <Stack.Screen options={{ title: 'Kategorien' }} />;
}
`;

    expect(countRule(lintScreen(source))).toBe(1);
  });

  it('rejects both hard-coded arguments of Alert.alert', () => {
    const source = `import { Alert, Button } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function Example() {
  const { t } = useTranslation();
  return (
    <Button
      title={t('common.next')}
      onPress={() => Alert.alert('Fehler', 'Etwas ging schief')}
    />
  );
}
`;

    expect(countRule(lintScreen(source))).toBe(2);
  });

  it('accepts translated screen titles and alerts', () => {
    const source = `import { Alert, Button } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';

export default function Example() {
  const { t } = useTranslation();
  return (
    <>
      <Stack.Screen options={{ title: t('categories.title') }} />
      <Button
        title={t('common.next')}
        onPress={() => Alert.alert(t('errors.title'), t('errors.generic'))}
      />
    </>
  );
}
`;

    expect(lintScreen(source)).not.toContain(RULE);
  });

  it('accepts technical strings in a realistic screen', () => {
    const source = `import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

type Params = { categoryId: string };

export default function Example() {
  const { t } = useTranslation();
  const { categoryId } = useLocalSearchParams<Params>();
  const isWeb = Platform.OS === 'web';

  return (
    <View style={styles.container} className="flex-1 items-center" testID="example">
      <Text>{t('home.title')}</Text>
      <TextInput keyboardType="email-address" autoComplete="email" testID="email" />
      <Pressable
        testID="next"
        onPress={() => router.push(isWeb ? '/categories' : \`/categories/\${categoryId}\`)}
      >
        <Text>{t('common.next')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
`;

    expect(lintScreen(source)).not.toContain(RULE);
  });
});
