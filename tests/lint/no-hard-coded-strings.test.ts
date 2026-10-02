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

describe('lint rule against hard-coded UI strings', () => {
  it('rejects hard-coded text in JSX', () => {
    const source = `import { Text } from 'react-native';

export default function Example() {
  return <Text>Hallo Welt</Text>;
}
`;

    expect(lintScreen(source)).toContain(RULE);
  });

  it('rejects hard-coded user-facing JSX attributes', () => {
    const source = `import { TextInput } from 'react-native';

export default function Example() {
  return <TextInput placeholder="Suche" accessibilityLabel="Suchfeld" />;
}
`;

    const ruleIds = lintScreen(source);

    expect(ruleIds.filter((ruleId) => ruleId === RULE)).toHaveLength(2);
  });

  it('accepts translated text and technical attributes', () => {
    const source = `import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function Example() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center" testID="example">
      <Text>{t('home.title')}</Text>
    </View>
  );
}
`;

    expect(lintScreen(source)).not.toContain(RULE);
  });
});
