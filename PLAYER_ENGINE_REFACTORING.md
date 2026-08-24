# Multi-Engine Player Architecture Refactoring

## Overview

The player engine has been refactored from a single monolithic file (2,778 lines) into a modular, platform-specific multi-engine architecture.

## New Architecture

```
src/core/
├── playerEngine.ts              # Main entry point (backward-compatible API)
├── playerEngine.legacy.ts       # Original implementation (for reference)
└── player/
    ├── index.ts                 # Module exports
    ├── PlayerInterface.ts       # Common interface definition
    ├── PlayerFactory.ts         # Platform detection & engine selection
    ├── platformDetection.ts     # Runtime detection utilities
    ├── bufferManager.ts         # Buffer preset management
    └── engines/
        ├── WebOSPlayerEngine.ts      # LG webOS TVs
        ├── CapacitorPlayerEngine.ts  # Android via Capacitor
        ├── ElectronPlayerEngine.ts   # Desktop (Electron/Tauri)
        └── BrowserPlayerEngine.ts    # Standard web browsers
```

## Platform-Specific Engines

### WebOSPlayerEngine (LG webOS TVs)
- Prefers native HLS playback for real manifests
- Uses HTTP instead of HTTPS (webOS restriction)
- Disables HLS.js workers (webOS limitation)
- Uses webOS debug logging

### CapacitorPlayerEngine (Android via Capacitor)
- Always uses HLS.js (never native HLS)
- Disables workers (Capacitor limitation)
- Handles .ts streams via native proxy
- Uses relay/proxy for CORS-restricted streams

### ElectronPlayerEngine (Desktop)
- Enables HLS.js workers for better performance
- Can use Shaka Player for VOD transcode playback
- Has access to local transcoder
- Extended timeouts for transcode operations
- Supports low-latency mode for live streams

### BrowserPlayerEngine (Web Browsers)
- Uses HLS.js for HLS streams
- Falls back to native HLS on Safari
- Enables workers for better performance
- Standard buffer settings

## Shared Components

- **PlayerInterface.ts** - Common `IPlayerEngine` interface all engines implement
- **platformDetection.ts** - Runtime detection (`isWebOsRuntime()`, `isCapacitorRuntime()`, etc.)
- **bufferManager.ts** - Buffer presets (off/low/medium/high) shared across engines
- **PlayerFactory.ts** - Auto-selects best engine via `createPlayerEngine()`

## Backward Compatibility

The public API is unchanged:
```typescript
initPlayerEngine();
playUrl(url, ...);
stopPlayback();
getPlaybackBufferLevel();
setPlaybackBufferLevel(level);
```

## Benefits

1. **Maintainability** - Each engine is 200-400 lines vs 2,778 lines of mixed logic
2. **Testability** - Can test each platform engine in isolation
3. **Performance** - Each engine uses optimal settings for its platform
4. **Extensibility** - Easy to add new platforms or modify platform-specific behavior
5. **Debugging** - Clear platform-specific logging and error messages

## Next Steps

1. **Gradual Enhancement** - Port complex fallback logic from `playerEngine.legacy.ts` into each engine
2. **Native Players** - Add ExoPlayer (Android), webOS native media APIs, mpv.js (Desktop)
3. **Performance Monitoring** - Track playback success rates per platform
4. **Code Splitting** - Tree-shake unused platform code per build target
