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

Timeshift support (if provider supports it)

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

3\. Run the Web Version

Code

npm run dev

🖥️ Building for Desktop (Tauri)

Install Tauri prerequisites

(Depends on OS — Rust, Cargo, system libs)

Then:

Code

cd desktop

npm install

npm run tauri dev

Build release:

Code

npm run tauri build

Output binaries appear in:

Code

/desktop/src-tauri/target/release/

📱 Building for Android (Capacitor)

1\. Build Web Assets

Code

npm run build

2\. Sync to Android

Code

npx cap sync android

3\. Open Android Studio

Code

npx cap open android

Build APK/AAB from Android Studio.

📺 Building for LG WebOS

Requirements

LG WebOS CLI

Developer mode enabled on TV

TV paired with CLI

Build

Code

npm run build

cd webos

ares-package .

Install to TV

Code

ares-install com.yourapp.ip.tv\_1.0.0\_all.ipk

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

npm run lint       # Lint code

npm run format     # Prettier formatting

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

