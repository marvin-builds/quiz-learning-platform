# ADR 0001 — Expo (React Native) with TypeScript as the single client stack

- **Status:** Accepted (2026-10-02, planning)
- **Context:** quiz learning platform, client apps for web, Android and iOS (desktop optional)
- **Deciders:** me, with Claude as the planning assistant
- Overview: [overview](../plan/overview.md)

## Context and problem

The platform needs the same features on web, Android and iPhone. Windows,
macOS and Linux apps are wanted only if they add little effort. I develop it
alone, full time. Building a separate native app per platform would multiply
the work, so the question was which **shared codebase** to use.

## Decision drivers

- One codebase for web, Android and iOS
- Web counts as much as mobile. SEO for public quiz and category pages is a
  nice to have, not a must.
- Admin screens (form-heavy, used in a desktop browser) should live in the
  same codebase
- Large ecosystem and good help available for a solo developer
- Desktop only if cheap

## Options considered

| | Expo / React Native (TS) | Flutter (Dart) | PWA + Capacitor | Kotlin Multiplatform + Compose |
|---|---|---|---|---|
| iOS / Android | Native UI, very mature | Own renderer, very mature | Web view in a wrapper | Mature |
| Web | Real DOM through Expo Router, SEO possible | Canvas rendering, heavy bundle, weak SEO | Native web | Wasm, still young |
| Desktop | Weak natively, so wrap the web build with Tauri | Stable on Windows, macOS and Linux | Wrap with Tauri or Electron | Good (JVM) |
| Admin shares code | Yes | Yes, but on a weak web target | Yes | Weak web target |
| Ecosystem | Largest | Large | Largest | Smaller |
| App store risk | Low | Low | Medium (Apple may reject thin wrappers) | Low |

A separate native app per platform was rejected immediately: it means three or
more codebases for one developer. .NET MAUI was rejected because it has no real
web target.

### Why Flutter's SEO is weak

Flutter web draws the whole UI onto a canvas, so the HTML that crawlers
receive contains almost no text. Flutter also has no server-side rendering.
The only workarounds are:

- **Pre-rendering:** static HTML snapshots of public routes are served to crawlers.
- **Hybrid:** a separate HTML site (e.g. Next.js) for the public pages, with
  Flutter only for the interactive app.

Both add a second thing to maintain, and the result stays weaker than a real
web stack. Sources:
[Miquido](https://www.miquido.com/flutter-101/seo-in-flutter/),
[Codesoltech](https://www.codesoltech.com/blog/flutter-for-web-seo/),
[SSR vs prerendering](https://fbipool.com/ssr-vs-prerendering-in-flutter-web-what-works-best-for-seo/).

## Decision

**Expo (React Native) + TypeScript + Expo Router** for web, Android and iOS.
The admin screens are part of the same app, visible only to the admin role.
Desktop, if wanted later, comes from wrapping the web build with Tauri.

Flutter was the close runner-up. It would be the better choice if desktop and
mobile mattered more than web.

## Consequences

**Positive:**

- One TypeScript codebase: the client, the admin, shared validation (zod) and
  types generated from the database
- Real HTML on web, so public pages can be statically rendered for SEO at no
  extra cost

**Negative, accepted:**

- **Upgrade churn.** There is a new Expo SDK roughly every 4 months, and
  third-party native libraries sometimes break on upgrade.
- **Web is a translation layer.** It works through react-native-web, so some
  components behave differently on web and full CSS isn't available. Expect
  some per-platform fixes.
- **Desktop is second-class.** It means a Tauri or Electron wrapper, not a
  native app.
- **Cloud builds have limits.** Expo's EAS build service has a limited free
  tier. Local builds are possible, but iOS builds need a Mac.
- **Platform order:** web and admin ship first, and the Android and iOS
  release follows from the same code.
