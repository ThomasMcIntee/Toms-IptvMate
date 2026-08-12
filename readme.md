# 📺 Tom'sIPTV Application — Cross‑Platform (Tauri + Capacitor + WebOS)

A modern, high‑performance IPTV player built with a shared Web UI core and deployed across:

Windows / macOS / Linux (Tauri)

Android (Capacitor)

LG WebOS TVs (WebOS SDK)

Browser (optional)

The app delivers a TiviMate‑style experience with a clean UI, fast navigation, and full EPG support.

🚀 Features

🎨 Modern UI

Clean, minimal, flat design

Light/Dark theme support

Smooth animations

Remote‑friendly layout for TVs

📺 IPTV Playback Engine

HLS streaming support

DASH optional

Multi‑source fallback

Fast channel switching

On‑screen display (OSD) with:

Channel info

Program info

Timeline

Quality indicators

🗂️ Categories \& Favorites

Auto categories from M3U groups

Custom user‑created categories

Favorites list

Hidden channels

Parental lock support

📅 EPG (Electronic Program Guide)

XMLTV parser

24h / 48h / 7‑day grid

TiviMate‑style EPG layout

Virtualized scrolling for performance

Jump‑to‑time

Program details modal

EPG caching for fast load

⚙️ Settings

Playlist management

EPG source management

Player buffer settings

Appearance/theme

Parental PIN

Backup/restore configuration
🎮 Remote Navigation

Arrow‑key grid navigation

Long‑press actions

TV remote key mapping:

WebOS

Android TV

Desktop keyboard

🏗️ Project Structure

Code

/app

&#x20; /core-ui        # Shared UI components

&#x20; /player         # Playback engine

&#x20; /epg            # EPG grid + parser

&#x20; /settings       # Settings UI + logic

&#x20; /navigation     # Remote + keyboard navigation

&#x20; /categories     # Category \& favorites system

&#x20; /parental       # PIN lock system

/desktop          # Tauri wrapper

/android          # Capacitor wrapper

/webos            # WebOS SDK wrapper

The /app folder is the heart of the project — all platforms load this same UI.

🧩 Technology Stack

Core Web App

TypeScript

React

Vite

Zustand (state management)

HLS.js (streaming)

XMLTV parser

Desktop (Tauri)

Rust backend

Secure IPC

Native window controls

Android (Capacitor)

WebView wrapper

Native plugins for:

File access

Network info

Remote control events

WebOS

LG WebOS SDK

Keycode mapping for Magic Remote

TV‑optimized layout

📥 Installation \& Setup

1\. Clone the Repository

Code

git clone [https://github.com/ThomasMcIntee/iptv-app](https://github.com/ThomasMcIntee/iptv-app)

cd Tomiptv

2\. Install Dependencies

Code

npm install

📦 npm Publish Check

Code

npm run publish:check

This runs a dry-run package build so the published tarball includes the Vite `dist/` output and Electron entrypoint without shipping the rest of the repository.

3\. Run the Web Version

Code

npm run dev

🚀 Build \& Publish Targets

Recommended command to build/package all targets:

Code

npm run build:all

Available target scripts:

Code

npm run build          # Web production build (dist/)
npm run webos:package  # Build + sync + package LG WebOS (.ipk)
npm run desktop:package # Package desktop app installer (release/)
npm run cap:sync       # Sync Capacitor native projects
npm run cap:android    # Open Android project in Android Studio
npm run android:build  # Android build helper script
npm run publish:check  # Dry-run npm publish package check

📄 Playlist \& EPG Setup

Supported Formats

M3U / M3U8 (with or without groups)

XMLTV (compressed or uncompressed)

Adding a Playlist

Open the app

Go to Settings → Playlists

Add:

URL playlist

Local file

Xtream Codes API

Adding EPG

Go to Settings → EPG Sources

Add XMLTV URL or file

Choose refresh interval

🔐 Parental Control

Set a 4‑digit PIN

Lock categories

Lock individual channels

Unlock timeout configurable

🧪 Development Scripts

Code

npm run dev        # Web dev server

npm run build      # Production build
npm run build:all  # Build/package all supported targets
npm run publish:check # npm package dry-run check

🛠️ Roadmap

Recording (DVR)

Multi‑EPG merge

Multi‑playlist merge

Cloud sync

Profiles

Picture‑in‑Picture

Timeshift buffer UI

🤝 Contributing

Pull requests are welcome.

For major changes, open an issue first to discuss what you’d like to change.

📜 License

MIT License.

[https://copilot.microsoft.com/shares/artifacts/q1Dx69x9YPCQ7jvns6bte](https://copilot.microsoft.com/shares/artifacts/q1Dx69x9YPCQ7jvns6bte)
