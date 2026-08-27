# 📺 Tom's IPTVmate

**A cross-platform IPTV player for Live TV, Movies, and Series — with full EPG, recording, and multi-playlist support.**

Tom's IPTVmate is a modern, feature-rich IPTV client that runs on **Windows Desktop (Electron)**, **Android (Capacitor)**, **iOS (Capacitor)**, **LG webOS TVs**, and **Web Browsers**. It supports M3U playlists, Xtream Codes API, and Stalker portals, giving you a unified viewing experience across all your devices.

![Version](https://img.shields.io/badge/version-1.4.4-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Android%20%7C%20iOS%20%7C%20webOS%20%7C%20Web-lightgrey)

---

## ✨ Features

### 📡 Multi-Source Playlist Support
- **M3U / M3U8** playlists (URL or file)
- **Xtream Codes API** (server / user / password)
- **Stalker / Minister portals** (portal URL + MAC address)
- Manage **multiple playlists** simultaneously with the Playlist Manager

### 📺 Live TV, Movies & Series
- **Live TV** with channel groups, favourites, and Now/Next EPG overlays
- **VOD (Video on Demand)** — browse movies from your playlists
- **TV Series** with season/episode picker and search
- Content categorised automatically into Live / Movies / Series

### 📖 Electronic Program Guide (EPG)
- **XMLTV** EPG parsing with indexed lookup
- **Xtream EPG** and **Stalker EPG** integration
- Full **TV Guide Search** — find what's on across all channels
- EPG timeline and grid views
- Automatic EPG refresh every 3 hours

### 🔴 Recording & Timeshift
- **Schedule recordings** for upcoming EPG programmes
- **Recording library** — browse and replay past recordings
- **Timeshift** — pause, rewind, and resume live TV
- Configurable recording storage management

### 🔐 Access Control & Profiles
- **Master / Adult / Child** access roles with PIN codes
- Per-role channel visibility and favourites
- Role-specific playlist assignments
- Optional login gate to protect content

### 🎬 Multi-Engine Playback
- Platform-optimised player engines:
  - **HLS.js** — adaptive HLS streaming (all platforms)
  - **Shaka Player** — DASH / VOD transcode playback (Desktop)
  - **Native HLS** — Safari and webOS fallback
- Configurable **buffer presets** (Off / Low / Medium / High)
- **Audio track** and **subtitle** selection
- Low-latency mode for live streams (Desktop)

### 🌐 Cross-Platform
| Platform | Technology | Status |
|----------|-----------|--------|
| 🖥️ Windows Desktop | Electron + electron-builder (NSIS) | ✅ Supported |
| 📱 Android | Capacitor 8 | ✅ Supported |
| 📱 iOS | Capacitor 8 | ✅ Supported |
| 📺 LG webOS TV | webOS CLI + ares-package | ✅ Supported |
| 🌍 Web Browser | Vite + React SPA | ✅ Supported |

### 🌍 Internationalisation
Available in **6 languages**: English, Español, Français, Deutsch, Italiano, Português.

### 🎯 TV & Remote Friendly
- Full **D-pad / remote control** navigation (arrow keys, Enter, Back)
- webOS remote key mapping (Return, Back, colour keys)
- Focus management for 10-foot UI experiences

### 🧩 Additional Features
- **Voice control** panel
- **Smart Home** integration panel
- **Offline** mode with cached content
- **Analytics** panel with event logging
- **Notifications** system
- **Dark / Light** mode toggle
- Series search with on-screen keyboard


---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | React 19 + TypeScript |
| Build Tool | Vite 8 |
| Desktop | Electron 43 + electron-builder |
| Mobile | Capacitor 8 (Android & iOS) |
| Smart TV | webOS CLI (@webos-tools/cli) |
| Video | HLS.js, Shaka Player |
| Language | TypeScript 7 |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and **npm**
- For Android: **Android Studio** with SDK
- For iOS: **macOS** with **Xcode** installed
- For webOS: **webOS CLI** (`@webos-tools/cli`)
- For Desktop: no extra dependencies beyond Node.js

### Install

```bash
npm install
```

### Development

```bash
# Start the Vite dev server (web)
npm run dev
```

### Build

```bash
# Build the web SPA
npm run build

# Preview the production build
npm run preview
```

---

## 📦 Platform Builds

### 🖥️ Windows Desktop (Electron)

```bash
npm run desktop:package
```

Produces a Windows NSIS installer in the `release/` directory.

### 📱 Android

```bash
# Sync Capacitor plugins
npm run cap:sync

# Open in Android Studio
npm run cap:android

# Or build the APK directly
npm run android:build
```

### 📱 iOS (macOS only)

```bash
# Add iOS platform (first time only)
npx cap add ios

# Sync Capacitor plugins
npm run cap:sync

# Open in Xcode
npm run cap:ios

# Or build for simulator directly
npm run ios:build
```

**Note:** iOS builds require macOS with Xcode installed. After building, you can open the project in Xcode for signing and deployment to devices or the App Store.

### 📺 LG webOS TV

```bash
# Sync the webOS build
npm run webos:sync

# Package as .ipk
npm run webos:package
```

### 🏗️ Build All Platforms

```bash
npm run build:all
```

This runs the full pipeline: web build → Capacitor sync → Android APK → iOS build → webOS .ipk → Windows installer.

---

## 📁 Project Structure

```
Toms-IPTVmate/
├── src/
│   ├── App.tsx                  # Main application shell
│   ├── main.tsx                 # React entry point
│   ├── core/                    # Core business logic
│   │   ├── playerEngine.ts      # Unified player API
│   │   ├── player/              # Multi-engine player architecture
│   │   │   ├── engines/         # Platform-specific engines
│   │   │   ├── PlayerFactory.ts # Auto-selects best engine
│   │   │   └── bufferManager.ts # Buffer presets
│   │   ├── loaders/             # Playlist & EPG loaders
│   │   │   ├── m3uLoader.ts     # M3U parser
│   │   │   ├── xtreamLoader.ts  # Xtream Codes API
│   │   │   ├── stalkerLoader.ts # Stalker portal
│   │   │   ├── xmltvParser.ts   # XMLTV EPG parser
│   │   │   └── epgLoader.ts     # Unified EPG loader
│   │   ├── channelStore.ts      # Channel state management
│   │   ├── epgStore.ts          # EPG state management
│   │   ├── playlistStore.ts     # Playlist persistence
│   │   ├── recordingEngine.ts   # Recording scheduler
│   │   └── navigation.ts        # Remote/keyboard navigation
│   ├── ui/                      # UI components
│   │   ├── ChannelList.tsx      # Channel list view
│   │   ├── EPGGrid.tsx          # EPG grid view
│   │   ├── EPGSearch.tsx        # TV guide search
│   │   ├── MainMenuScreen.tsx   # Main menu
│   │   ├── PlaylistManager.tsx  # Playlist management
│   │   ├── RecordingLibrary.tsx # Recording browser
│   │   └── SeriesEpisodePicker.tsx
│   ├── profiles/                # Access control & profiles
│   ├── subtitles/               # Audio & subtitle panels
│   ├── timeshift/               # Timeshift controls
│   ├── vod/                     # VOD & Series panels
│   ├── voice/                   # Voice control
│   ├── analytics/               # Analytics panel
│   ├── notifications/           # Notification system
│   └── offline/                 # Offline mode
├── electron/                    # Electron main process
├── android/                     # Capacitor Android project
├── ios/                         # Capacitor iOS project (macOS only)
├── webos/                       # webOS build output
├── scripts/                     # Build & utility scripts
└── package.json
```

---

## 🎮 Navigation

| Key | Action |
|-----|--------|
| `Arrow Keys` | Navigate channels / menu items |
| `Enter` / `OK` | Select / Play |
| `Backspace` / `Back` / `Return` | Go back / Open main menu |
| `Escape` | Open main menu from anywhere |
| `Double-click` | Toggle fullscreen (web) |

---

## 📝 Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build production web SPA |
| `npm run preview` | Preview production build |
| `npm run desktop:package` | Build Windows installer |
| `npm run android:build` | Build Android APK |
| `npm run ios:build` | Build iOS app (macOS only) |
| `npm run webos:package` | Package webOS .ipk |
| `npm run build:all` | Build all platforms |
| `npm run cap:sync` | Sync Capacitor plugins |
| `npm run cap:android` | Open Android Studio |
| `npm run cap:ios` | Open Xcode (macOS only) |

---

## 🤝 Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request on [GitHub](https://github.com/ThomasMcIntee/Toms-IptvMate).

---

## 📄 License

MIT © Thomas McIntee

---

<p align="center">
  <b>Tom's IPTVmate</b> — Your IPTV companion on every screen.
</p>

