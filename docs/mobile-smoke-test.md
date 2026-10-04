# Mobile smoke test (Android)

Once per phase, the human installs the app on an Android phone or emulator
and checks that nothing broke on mobile. It is a manual check, not a release:
store builds, signing for Google Play and iOS come later (plan § 1 and
phase 4).

There are two builds, both defined in [`eas.json`](../eas.json):

| Profile | What it is | Backend |
|---|---|---|
| `preview` | A standalone, installable APK | The hosted project, with its public URL and publishable key only |
| `development` | A development client that loads the JS from the local dev server | Whatever `.env` (or `.env.local`) points to, normally the local stack |

## One-time setup (human)

1. An Expo account. Log in with `npx -y eas-cli@24.10.0 login`, then run
   `eas init` once (`npx -y eas-cli@24.10.0 init`) on a branch and commit the
   `extra.eas.projectId` and `owner` it writes into `app.json`. Builds fail
   without them.
2. Create an access token on expo.dev and store it as the `EXPO_TOKEN`
   secret of the `production` environment on GitHub, next to
   `SUPABASE_PUBLISHABLE_KEY`.
3. A phone with USB debugging, or an emulator, and `adb` on the dev machine.

The Android package id is `io.github.marvinmai.quiz` (`app.json`). Never
change it: a new id is a new app on devices and in the store.

## Build the preview APK

The build runs by hand only, never on a PR, in the workflow
[`android-preview.yml`](../.github/workflows/android-preview.yml). It runs
`eas build --local` on the GitHub runner, so it uses no EAS build credits and
the hosted key never leaves GitHub's secrets. Start it from `main` (the
`production` environment is restricted to `main`):

```sh
gh workflow run android-preview.yml --ref main
```

Or on GitHub: Actions → "Android preview APK" → "Run workflow" on `main`.
A build takes about 20 minutes. When it fails within the first minute with
"The bearer token is invalid", replace the `EXPO_TOKEN` secret (see the
one-time setup).

### Install it on the phone

The APK is attached to the finished run, not to a release:

1. On the phone, open the repository's Actions tab in the browser (logged in
   to GitHub; the GitHub app can't download artifacts), then the latest
   "Android preview APK" run.
2. Below the job summary, under **Artifacts**, tap `quiz-preview-apk`. If the
   section is missing, switch the browser to "Desktop site".
3. The download is a zip: open it in the Files app, extract it and tap
   `quiz-preview.apk`. Allow installing unknown apps from that app when
   Android asks.

From the dev machine instead, with the phone connected by USB:

```sh
run=$(gh run list --workflow android-preview.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$run" --exit-status
gh run download "$run" --name quiz-preview-apk
adb install -r quiz-preview.apk
```

Artifacts are kept for 90 days.

The workflow fails when the APK's bundle doesn't contain the hosted URL or
still contains the local stack's URL or key.

Until admins create content in phase 2, the hosted backend has no quizzes
(plan § 7 "Hosted content"), so the APK shows the empty state and the steps
that need a quiz can't pass yet.

## Build and run the development client

Build the development client once (again after native dependencies change):

```sh
npx expo run:android
```

This builds a debug app on the dev machine and needs the Android SDK and
JDK 17. Alternatively, with an Expo account,
`npx -y eas-cli@24.10.0 build --local -p android --profile development`
builds an installable development client APK. Then start the dev server and
open the app on the phone:

```sh
npx supabase start
npx expo start
```

`npm run android` now opens the development client, not Expo Go.

### Reach the local Supabase stack from a phone

`.env` points the app to `http://127.0.0.1:54321`, which on a phone is the
phone itself. Two ways around it:

- **USB or emulator (preferred):** forward the ports to the dev machine, so
  `127.0.0.1` works unchanged:

  ```sh
  adb reverse tcp:54321 tcp:54321
  adb reverse tcp:8081 tcp:8081
  ```

  `8081` is the dev server. Repeat after reconnecting the phone.

- **Wi-Fi:** create a `.env.local` (ignored by git) with the dev machine's
  LAN address, e.g. `EXPO_PUBLIC_SUPABASE_URL=http://192.168.1.20:54321`,
  and restart `npx expo start --clear`. The local stack listens on all
  interfaces; the firewall must allow port 54321. Delete `.env.local`
  afterwards: it also applies to web exports on that machine, such as the
  one `npm run test:e2e` builds.

Debug builds allow plain HTTP; the preview build talks to the hosted HTTPS
URL only.

## Smoke checklist

Run it in the preview APK. Note the result, the build and the device in the
phase's issue.

- [ ] Install the APK and open the app; the
      start screen shows without an error.
- [ ] Open a category; its quizzes are listed (or the empty state shows).
- [ ] Play a quiz to the end, answering every question.
- [ ] See the result with the score.
- [ ] Switch the language: set the phone's system language to English (or
      German), force-stop or swipe away the app and reopen it; the texts
      follow.
