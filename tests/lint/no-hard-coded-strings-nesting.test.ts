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

describe('lint rule against hard-coded UI strings in nested and shared places', () => {
  it('rejects hard-coded text in JSX rendered from a list', () => {
    const source = `import { Button, Text, View } from 'react-native';

export default function Example({ ids }: { ids: string[] }) {
  return (
    <View>
      {ids.map((id) => (
        <View key={id}>
          <Text>Kategorie</Text>
          <Button title="Weiter" onPress={() => undefined} />
        </View>
      ))}
    </View>
  );
}
`;

    expect(countRule(lintScreen(source))).toBe(2);
  });

  it('rejects hard-coded text in a component wrapped in memo', () => {
    const source = `import { memo } from 'react';
import { Text } from 'react-native';

export default memo(function Example() {
  return <Text>Hallo</Text>;
});
`;

    expect(countRule(lintScreen(source))).toBe(1);
  });

  it('rejects a hard-coded title in a layout screenOptions', () => {
    const source = `import { Stack } from 'expo-router';

export default function Layout() {
  return <Stack screenOptions={{ title: 'Quiz', headerTintColor: '#fff' }} />;
}
`;

    expect(countRule(lintScreen(source))).toBe(1);
  });

  it('rejects hard-coded alert button text but allows the button style', () => {
    const source = `import { Alert, Pressable, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function Example() {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={() =>
        Alert.alert(t('errors.title'), t('errors.generic'), [
          { text: 'Abbrechen', style: 'cancel' },
        ])
      }
    >
      <Text>{t('common.next')}</Text>
    </Pressable>
  );
}
`;

    expect(countRule(lintScreen(source))).toBe(1);
  });

  it('accepts technical calls in event handlers', () => {
    const source = `import { useState } from 'react';
import { Linking, Pressable, Text } from 'react-native';
import { router, useNavigation } from 'expo-router';
import { useTranslation } from 'react-i18next';

export default function Example() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const [mode, setMode] = useState('view');
  return (
    <Pressable
      testID={mode}
      onPress={() => {
        setMode('edit');
        router.replace('/categories');
        navigation.setOptions({ headerShown: false });
        void Linking.openURL('https://example.org');
      }}
      onLongPress={() => router.push({ pathname: '/quiz/[id]', params: { id: '1' } })}
    >
      <Text>{t('common.next')}</Text>
    </Pressable>
  );
}
`;

    expect(lintScreen(source)).not.toContain(RULE);
  });
});
