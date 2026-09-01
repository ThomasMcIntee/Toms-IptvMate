# Repository Guidelines

## Project Overview
- Tom's IPTVmate is a Vite + React + TypeScript IPTV client.
- The web app lives in `/home/runner/work/Toms-IptvMate/Toms-IptvMate/src`.
- Desktop packaging uses Electron from `/home/runner/work/Toms-IptvMate/Toms-IptvMate/electron/main.cjs`.
- Mobile and TV platform wrappers live in `/home/runner/work/Toms-IptvMate/Toms-IptvMate/android`, `webos`, and Capacitor config files in the repo root.

## Important Directories
- `src/App.tsx` contains the main application shell and most top-level state.
- `src/core` contains playlist loading, EPG, playback, storage, navigation, and recording logic.
- `src/ui` contains the TV-style React screens and panels.
- `src/vod`, `src/subtitles`, `src/timeshift`, `src/analytics`, `src/notifications`, and `src/profiles` hold feature-specific UI and state helpers.
- `scripts` contains packaging and platform-sync helper scripts.

## Working Agreement
- Prefer small, surgical changes in the existing files instead of broad refactors.
- Match the existing TypeScript and React style; avoid adding comments unless they are necessary.
- The repository currently has build scripts but no dedicated lint or automated test script in `package.json`.
- For code changes, validate with the smallest relevant existing command, usually `npm run build`.

## Commands
- Install dependencies: `npm install`
- Start local development: `npm run dev`
- Build the web app: `npm run build`
- Preview the production build: `npm run preview`
- Dry-run the package contents: `npm run publish:check`
- Package desktop app: `npm run desktop:package`
- Sync Capacitor platforms: `npm run cap:sync`
- Package webOS build: `npm run webos:package`

## Validation Notes
- There is no existing `npm test` or `npm run lint` command at the time of writing.
- Desktop, Android, iOS, and webOS packaging commands are heavier than the standard web build; only run them when the change touches those paths.
- Keep generated artifacts and dependencies out of commits unless the task explicitly requires updating them.
