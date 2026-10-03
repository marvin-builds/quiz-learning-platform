/**
 * @jest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EAS_JSON = path.join(ROOT, 'eas.json');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');

type Profile = {
  developmentClient?: boolean;
  distribution?: string;
  android?: { buildType?: string };
  env?: Record<string, string>;
};
type EasConfig = {
  cli?: { version?: unknown; appVersionSource?: unknown };
  build?: Record<string, Profile | undefined>;
};

function easText(): string {
  if (!existsSync(EAS_JSON)) throw new Error('eas.json does not exist');
  return readFileSync(EAS_JSON, 'utf8');
}

function eas(): EasConfig {
  return JSON.parse(easText()) as EasConfig;
}

function profile(name: string): Profile {
  const found = eas().build?.[name];
  if (!found) throw new Error(`eas.json has no build profile "${name}"`);
  return found;
}

// The hosted URL the web deploy uses, so the APK and the web build talk to the
// same backend.
function hostedUrl(): string {
  const match = /^\s*EXPO_PUBLIC_SUPABASE_URL:\s*(\S+)\s*$/m.exec(readFileSync(CI, 'utf8'));
  if (!match) throw new Error('ci.yml sets no EXPO_PUBLIC_SUPABASE_URL');
  return match[1].replace(/^(['"])(.*)\1$/, '$2');
}

describe('eas.json build profiles', () => {
  it('has a development profile that builds a development client for internal distribution', () => {
    const development = profile('development');

    expect(development.developmentClient).toBe(true);
    expect(development.distribution).toBe('internal');
  });

  it('has a preview profile that builds a standalone APK for internal distribution', () => {
    const preview = profile('preview');

    expect(preview.distribution).toBe('internal');
    expect(preview.android?.buildType).toBe('apk');
    expect(preview.developmentClient ?? false).toBe(false);
  });

  it('points the preview build at the hosted Supabase URL the web deploy uses', () => {
    expect(hostedUrl()).toBe('https://kiywcqhicsesgknlwjyy.supabase.co');
    expect(profile('preview').env?.EXPO_PUBLIC_SUPABASE_URL).toBe(hostedUrl());
  });

  it('contains no Supabase key, which stays a GitHub secret', () => {
    const text = easText();

    for (const forbidden of [
      'sb_publishable_',
      'sb_secret_',
      'service_role',
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      'eyJ',
      'SUPABASE_ANON_KEY',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('pins the EAS CLI version and keeps the app version in app.json', () => {
    const cli = eas().cli;

    expect(typeof cli?.version).toBe('string');
    expect((cli?.version as string).trim()).not.toBe('');
    expect(cli?.appVersionSource).toBe('local');
  });
});

describe('app.json for Android', () => {
  it('has the stable Android package id', () => {
    const app = JSON.parse(readFileSync(path.join(ROOT, 'app.json'), 'utf8')) as {
      expo: { android?: { package?: string } };
    };

    expect(app.expo.android?.package).toBe('io.github.marvinmai.quiz');
  });
});

describe('package.json for the development client', () => {
  it('depends on expo-dev-client at runtime', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies).toHaveProperty('expo-dev-client');
  });
});
