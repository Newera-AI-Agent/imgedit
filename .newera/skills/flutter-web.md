---
name: flutter-web
description: Build and verify a Flutter web project on a Linux CI runner. Use for any task whose repo has `pubspec.yaml`, or whose brief asks for a Flutter/Dart app or cross-platform mobile+web app. Covers installing the Flutter SDK on the runner, scaffolding, the converge build loop, and producing `build/web/` (the static dir the deploy stage expects). Read BEFORE the first `flutter` command.
---

# Flutter web on a Linux runner

## Quick facts

- The runner does NOT ship the Flutter SDK. Install it once per job:
  ```bash
  cd /tmp && git clone --depth 1 -b stable https://github.com/flutter/flutter.git
  export PATH="/tmp/flutter/bin:$PATH"
  flutter --version          # first run bootstraps Dart; takes 1-3 min
  ```
- **Scaffold from zero:** `flutter create . --project-name <snake_case_name> --platforms web` (run in the repo root so the build finds `pubspec.yaml` at root). The project name in `pubspec.yaml` must be a valid Dart identifier (lowercase, underscores).
- **Deploy contract:** `flutter build web` produces `build/web/` with `index.html` — exactly the static dir the deploy stage ships. Use `--web-renderer canvaskit` (default) and keep the base href relative (default `--base-href /` is correct for the pages host).
- Node/Java are not needed; the Linux runner has everything else (`curl`, `unzip`, `git`).

## The build loop

1. `flutter pub get`
2. `flutter analyze` — treat analyzer errors as build errors (they gate `flutter build` anyway).
3. `flutter build web --release` — first build as smoke test.
4. Verify: `ls build/web/` must show `index.html`, `flutter.js`, `main.dart.js`, `assets/`.
5. Add features in slices; re-run `flutter build web --release` after each. Red analyze → fix before adding features.
6. Widget test: `flutter test` (add `test/widget_test.dart` if absent — scaffold ships one).

## File conventions

```
lib/
  main.dart           ← entry: runApp(const MyApp()) — REQUIRED
  <feature>/          ← feature modules (screens, widgets, models)
test/                 ← *_test.dart files for `flutter test`
web/                  ← index.html template, manifest
pubspec.yaml          ← name: / dependencies: / assets: (2-space indent, EXACT)
```

- `pubspec.yaml` is whitespace-sensitive: `dependencies:` then two spaces, package name colon, then version. Never tab-indent it.
- Assets must be listed under `flutter: assets:` AND live at the exact path — an unlisted asset loads as null at runtime, not at compile time.
- `const` constructors everywhere possible — the default lints flag non-const constructors.

## Common failure → fix table

| Error | Fix |
|---|---|
| `Target of URI doesn't exist: 'package:x/…'` | `flutter pub get`, or the import path typo'd |
| `Error: Method not found '…'` | wrong API for the installed SDK version — check the widget docs, not memory |
| `pubspec.yaml: … expected a key` | indentation broken (2 spaces, never tabs) |
| `main.dart` missing `main()` | every app needs `void main() => runApp(const App());` |
| Build ok but blank page | `base-href` mismatch or missing asset; check browser console in `build/web/index.html` |
| `flutter: command not found` | PATH export lost between shell steps — re-export in the same command line |

## Pre-finish checklist

- [ ] `flutter analyze` clean
- [ ] `flutter build web --release` exits 0
- [ ] `build/web/index.html` + `main.dart.js` exist
- [ ] `flutter test` (if specs exist) exits 0
- [ ] no debug `print()` spam in release code
- [ ] `request_deploy{subdomain, build_output_path:"build/web"}` only after all of the above