import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

const RELAY_PATH = "/__stream";
const TRANSCODE_PATH = "/__transcode";
const REDIRECT_LIMIT = 5;
const CURRENT_TRANSCODE_PROFILE = "mpegts-v20";
const TRANSCODE_MANIFEST_WAIT_MS = 60000;
const TRANSCODE_INIT_WAIT_MS = 60000;
const TRANSCODE_SEGMENT_WAIT_MS = 30000;

type AudioMode = "standard" | "compat" | "safe";

type SourceProbeInfo = {
  preferredAudioStreamIndex: number | null;
  preferredAudioStreamOrder: number | null;
  videoCodecName: string | null;
  videoPixelFormat: string | null;
  audioCodecName: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
};

type TranscodeSession = {
  id: string;
  sourceUrl: string;
  relaySourceUrl: string;
  inputMode: "relay" | "direct";
  hasTriedDirectInputFallback: boolean;
  hasTriedRelayInputFallback: boolean;
  directInputRestartCount: number;
  audioEnabled: boolean;
  audioMode: AudioMode;
  audioPipeline: "aac-transcode" | "aac-copy" | null;
  profile: string;
  movieInputAttempts: string[];
  baseDir: string;
  dir: string;
  playlistPath: string;
  proc: ChildProcessWithoutNullStreams | null;
  ffmpegMissing: boolean;
  lastError: string | null;
  lastUsed: number;
  nextSpawnAllowedAt: number;
  spawnWindowStartAt: number;
  spawnWindowCount: number;
  probeInfo: SourceProbeInfo;
};

const transcodeSessions = new Map<string, TranscodeSession>();
const sourceProbeCache = new Map<string, SourceProbeInfo>();
const movieVariantCache = new Map<string, string>();
const TRANSCODE_STALE_SESSION_MS = 60_000;
const TRANSCODE_RESPAWN_COOLDOWN_MS = 2500;
const TRANSCODE_SPAWN_WINDOW_MS = 15000;
const TRANSCODE_MAX_SPAWNS_PER_WINDOW = 3;

function reapStaleTranscodeSessions() {
  const now = Date.now();

  for (const [sessionId, session] of transcodeSessions.entries()) {
    if (now - session.lastUsed <= TRANSCODE_STALE_SESSION_MS) {
      continue;
    }

    if (session.proc && !session.proc.killed) {
      try {
        session.proc.kill();
      } catch {
        // Ignore kill errors during stale session cleanup.
      }
    }

    transcodeSessions.delete(sessionId);
  }
}

function getTranscodeSessionId(
  sourceUrl: string,
  audioEnabled: boolean,
  audioMode: AudioMode,
  sessionKeySalt = ""
): string {
  const avLabel = audioEnabled ? "av" : "video-only";
  return crypto
    .createHash("sha1")
    .update(`${CURRENT_TRANSCODE_PROFILE}|${avLabel}|${audioEnabled ? audioMode : "na"}|${sourceUrl}|${sessionKeySalt}`)
    .digest("hex")
    .slice(0, 16);
}

function getSessionDir(sessionId: string): string {
  return path.join(os.tmpdir(), "iptvmate-transcode", sessionId);
}

function resolveFfmpegExecutable(): string {
  const explicit = process.env.FFMPEG_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const wingetLink = path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
    if (fs.existsSync(wingetLink)) {
      return wingetLink;
    }
  }

  return "ffmpeg";
}

function resolveFfprobeExecutable(): string {
  const ffmpegExecutable = resolveFfmpegExecutable();
  if (ffmpegExecutable.toLowerCase().endsWith("ffmpeg.exe")) {
    return `${ffmpegExecutable.slice(0, -"ffmpeg.exe".length)}ffprobe.exe`;
  }

  if (ffmpegExecutable.toLowerCase().endsWith("ffmpeg")) {
    return `${ffmpegExecutable.slice(0, -"ffmpeg".length)}ffprobe`;
  }

  return "ffprobe";
}

type ProbedStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { default?: number };
  tags?: { language?: string; title?: string };
};

function probeSourceStreamInfo(inputUrl: string): SourceProbeInfo {
  const ffprobeExecutable = resolveFfprobeExecutable();
  const probe = spawnSync(
    ffprobeExecutable,
    [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      inputUrl
    ],
    {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true
    }
  );

  if (probe.error || probe.status !== 0 || !probe.stdout) {
    return {
      preferredAudioStreamIndex: null,
      preferredAudioStreamOrder: null,
      videoCodecName: null,
      videoPixelFormat: null,
      audioCodecName: null,
      audioSampleRate: null,
      audioChannels: null
    };
  }

  try {
    const parsed = JSON.parse(probe.stdout) as { streams?: ProbedStream[] };
    const videoStream = (parsed.streams || []).find((stream) => stream.codec_type === "video");
    const audioStreams = (parsed.streams || []).filter((stream) => stream.codec_type === "audio");
    if (!audioStreams.length) {
      return {
        preferredAudioStreamIndex: null,
        preferredAudioStreamOrder: null,
        videoCodecName: videoStream?.codec_name || null,
        videoPixelFormat: (videoStream as { pix_fmt?: string } | undefined)?.pix_fmt || null,
        audioCodecName: null,
        audioSampleRate: null,
        audioChannels: null
      };
    }

    const scored = audioStreams
      .map((stream, order) => {
        const title = (stream.tags?.title || "").toLowerCase();
        const language = (stream.tags?.language || "").toLowerCase();
        let score = 0;

        if (stream.disposition?.default) score += 100;
        if (language === "eng" || language === "en") score += 20;
        if (stream.channels && stream.channels >= 2) score += 10;
        if (stream.codec_name === "aac") score += 40;
        if (stream.codec_name === "ac3" || stream.codec_name === "eac3") score += 2;
        if (title.includes("main") || title.includes("original")) score += 12;
        if (title.includes("commentary") || title.includes("descriptive")) score -= 30;

        return { index: stream.index, order, score };
      })
      .filter((stream) => typeof stream.index === "number")
      .sort((left, right) => right.score - left.score);

    const preferredAudio = audioStreams.find((stream) => stream.index === scored[0]?.index) || audioStreams[0];

    return {
      preferredAudioStreamIndex: scored.length ? (scored[0].index ?? null) : null,
      preferredAudioStreamOrder: scored.length ? (scored[0].order ?? null) : null,
      videoCodecName: videoStream?.codec_name || null,
      videoPixelFormat: (videoStream as { pix_fmt?: string } | undefined)?.pix_fmt || null,
      audioCodecName: preferredAudio?.codec_name || null,
      audioSampleRate: preferredAudio?.sample_rate ? Number(preferredAudio.sample_rate) || null : null,
      audioChannels: preferredAudio?.channels || null
    };
  } catch {
    return {
      preferredAudioStreamIndex: null,
      preferredAudioStreamOrder: null,
      videoCodecName: null,
      videoPixelFormat: null,
      audioCodecName: null,
      audioSampleRate: null,
      audioChannels: null
    };
  }
}

function getSourceProbeInfo(sourceUrl: string): SourceProbeInfo {
  const cached = sourceProbeCache.get(sourceUrl);
  if (cached) {
    return cached;
  }

  const probed = probeSourceStreamInfo(sourceUrl);
  sourceProbeCache.set(sourceUrl, probed);
  return probed;
}

function ensureCleanSessionDir(dir: string) {
  // Keep cleanup minimal. On Windows, deleting recently-used FFmpeg output dirs can
  // fail with EPERM while file handles are still being released.
  fs.mkdirSync(dir, { recursive: true });
}

function allocateSessionRunDir(session: TranscodeSession): void {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  session.dir = path.join(session.baseDir, runId);
  session.playlistPath = path.join(session.dir, "index.m3u8");
}

function toRelayInputUrl(host: string | undefined, sourceUrl: string): string {
  const safeHost = host && host.trim() ? host : "localhost:5173";
  return `http://${safeHost}${RELAY_PATH}?url=${encodeURIComponent(sourceUrl)}`;
}

function normalizeProblematicLiveSourceUrl(sourceUrl: string): string {
  // Some Xtream live providers publish a broken .m3u8 endpoint while the
  // sibling .ts URL is the actual stable ingest target for FFmpeg.
  if (/\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(sourceUrl)) {
    return sourceUrl.replace(/\.m3u8(?=\?|$)/i, ".ts");
  }

  return sourceUrl;
}

function normalizeProblematicVodSourceUrl(sourceUrl: string): string {
  // Some Xtream VOD providers block .m3u8 requests but serve .mkv or .mp4 directly.
  // Try .mkv container format instead of HLS manifest (.m3u8) for better provider compatibility.
  if (/\/(movie|series)\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(sourceUrl)) {
    return sourceUrl.replace(/\.m3u8(?=\?|$)/i, ".mkv");
  }

  return sourceUrl;
}

function shouldPreferRelayInput(sourceUrl: string): boolean {
  // Temporarily disabled relay for VOD to test direct FFmpeg input
  const isLiveLike = /\/(live)\/[^/]+\/[^/]+\/\d+\.[a-z0-9]+(?:\?|$)/i.test(sourceUrl);
  return isLiveLike;
}

function buildDirectInputHeaderArgs(inputUrl: string): string[] {
  try {
    const parsed = new URL(inputUrl);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const headers = `Referer: ${origin}/\r\nOrigin: ${origin}\r\n`;
    return ["-headers", headers];
  } catch {
    return [];
  }
}

function startTranscoder(session: TranscodeSession) {
  const now = Date.now();
  const isVodSession = /\/(movie|series)\//i.test(session.sourceUrl);
  const attemptedMovieInputs =
    Array.isArray(session.movieInputAttempts) && session.movieInputAttempts.length > 0
      ? session.movieInputAttempts
      : [session.sourceUrl];
  session.movieInputAttempts = attemptedMovieInputs;

  if (!session.proc || session.proc.killed) {
    // If this session already has a playable playlist+segment set, avoid
    // needlessly respawning ffmpeg on subsequent requests.
    if (!isVodSession && sessionHasPlayableOutput(session)) {
      session.nextSpawnAllowedAt = 0;
      return;
    }

    // Throttle rapid respawn loops when ffmpeg exits early.
    if (now < session.nextSpawnAllowedAt) {
      return;
    }

    // Hard-stop repeated spawn churn for the same session when no playable
    // output appears. Resume after cooldown or user retrigger.
    if (now - session.spawnWindowStartAt > TRANSCODE_SPAWN_WINDOW_MS) {
      session.spawnWindowStartAt = now;
      session.spawnWindowCount = 0;
    }
    if (session.spawnWindowCount >= TRANSCODE_MAX_SPAWNS_PER_WINDOW) {
      session.lastError = "Transcoder restart loop detected. Please retry this stream.";
      session.nextSpawnAllowedAt = now + 10000;
      return;
    }
  }

  const shouldUseRelayFirst = shouldPreferRelayInput(session.sourceUrl);
  // Even when relay-first is preferred, allow fallback to direct input when relay
  // still returns persistent upstream 5xx responses for a given provider.
  const allowDirectFallback = true;
  if (shouldUseRelayFirst && session.inputMode !== "relay") {
    // Enforce relay-first ingest for live-style sources on reused sessions.
    // If a stale direct worker is active, recycle it so the next spawn uses relay.
    session.inputMode = "relay";
    session.hasTriedDirectInputFallback = false;
    session.hasTriedRelayInputFallback = true;

    if (session.proc && !session.proc.killed) {
      try {
        session.proc.kill();
      } catch {
        // Ignore kill errors; a fresh spawn attempt below still guards on proc state.
      }
    }
  }

  if (!shouldUseRelayFirst && session.inputMode !== "direct" && !session.hasTriedRelayInputFallback) {
    // Non-live sources (movie/series VOD) should start direct-first, but once
    // relay fallback is selected for this session we must preserve relay mode.
    session.inputMode = "direct";
    session.hasTriedDirectInputFallback = true;
    session.hasTriedRelayInputFallback = false;
  }

  if (session.proc && !session.proc.killed) {
    return;
  }

  session.spawnWindowCount += 1;
  console.log(`[transcode-spawn] session=${session.id} inputMode=${session.inputMode} starting FFmpeg process`);

  allocateSessionRunDir(session);
  ensureCleanSessionDir(session.dir);
  const effectiveInputMode: "relay" | "direct" = shouldUseRelayFirst ? "relay" : session.inputMode;
  const inputUrl = effectiveInputMode === "direct" ? session.sourceUrl : session.relaySourceUrl;

  const sourceForModeCheck = (() => {
    try {
      return decodeURIComponent(session.sourceUrl);
    } catch {
      return session.sourceUrl;
    }
  })();
  const isLiveLikeSource = /\/live\//i.test(sourceForModeCheck) || /%2Flive%2F/i.test(session.sourceUrl);
  const isVodLikeSource = /\/(movie|series)\//i.test(sourceForModeCheck) || /%2F(movie|series)%2F/i.test(session.sourceUrl);
  const useFmp4Segments = false;
  const useOpusAudio = false;
  const segmentPattern = path.join(session.dir, useFmp4Segments ? "seg_%06d.m4s" : "seg_%06d.ts");
  const preferredAudioStreamOrder = session.probeInfo.preferredAudioStreamOrder;
  const audioMap = typeof preferredAudioStreamOrder === "number"
    ? `0:a:${preferredAudioStreamOrder}?`
    : "0:a:0?";
  const useMp3Audio = false;
  const audioSampleRate = "48000";
  const audioBitrate = "128k";
  const videoArgs = [
    "-c:v",
    "libx264",
    "-profile:v",
    "main",
    "-level:v",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency"
  ];
  const transportArgs =
    effectiveInputMode === "direct"
      ? [
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_at_eof",
          "1",
          "-reconnect_delay_max",
          "2",
          "-rw_timeout",
          "15000000"
        ]
      : [];
  const directInputHeaderArgs = effectiveInputMode === "direct" ? buildDirectInputHeaderArgs(inputUrl) : [];
  const probeArgs = isVodLikeSource
    ? [
        "-analyzeduration",
        "15000000",
        "-probesize",
        "15000000"
      ]
    : [
        "-analyzeduration",
        "2000000",
        "-probesize",
        "2000000"
      ];
  const sourceIsAac = session.probeInfo.audioCodecName === "aac";
  const shouldCopyAacAudio = false; // Always transcode audio for consistent output
  session.audioPipeline = session.audioEnabled ? (useOpusAudio ? "opus" : shouldCopyAacAudio ? "aac-copy" : "aac-transcode") : null;
  const audioArgs = session.audioEnabled
    ? useOpusAudio
      ? [
          "-map",
          audioMap,
          "-c:a",
          "libopus",
          "-b:a",
          "128k",
          "-ac",
          "2",
          "-ar",
          "48000",
          "-vbr",
          "on"
        ]
      : [
          "-map",
          audioMap,
          "-c:a",
          "aac",
          "-b:a",
          audioBitrate,
          "-ac",
          "2",
          "-ar",
          audioSampleRate,
          "-metadata:s:a:0",
          "language=eng"
        ]
    : ["-an"];
  const hlsOutputArgs = (isVodLikeSource && !isLiveLikeSource)
    ? [
        "-hls_time",
        "2",
        "-hls_list_size",
        "0",
        "-hls_allow_cache",
        "0",
        ...(useFmp4Segments
          ? [
              "-hls_segment_type",
              "fmp4",
              "-hls_fmp4_init_filename",
              "init.mp4"
            ]
          : []),
        "-hls_flags",
        "append_list+independent_segments"
      ]
    : [
        "-hls_time",
        "2",
        "-hls_list_size",
        "4",
        "-hls_playlist_type",
        "event",
        "-hls_allow_cache",
        "0",
        ...(useFmp4Segments
          ? [
              "-hls_segment_type",
              "fmp4",
              "-hls_fmp4_init_filename",
              "init.mp4"
            ]
          : []),
        "-hls_flags",
        "delete_segments+append_list+independent_segments"
      ];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-user_agent",
    "Mozilla/5.0 IPTVmate Relay",
    ...directInputHeaderArgs,
    ...transportArgs,
    ...probeArgs,
    "-err_detect",
    "ignore_err",
    "-fflags",
    "+genpts+discardcorrupt",
    "-i",
    inputUrl,
    "-map",
    "0:v:0",
    ...audioArgs,
    "-vf",
    "setpts=PTS-STARTPTS",
    ...videoArgs,
    "-avoid_negative_ts",
    "make_zero",
    "-muxpreload",
    "0",
    "-muxdelay",
    "0",
    "-f",
    "hls",
    ...hlsOutputArgs,
    "-hls_segment_filename",
    segmentPattern,
    session.playlistPath
  ];

  const ffmpegExecutable = resolveFfmpegExecutable();
  if (session.audioEnabled) {
    console.log(
      `[transcode] session=${session.id} amode=${session.audioMode} input=${effectiveInputMode} audioMap=${audioMap} sourceAudioOrd=${preferredAudioStreamOrder ?? "na"} sourceAudioCodec=${session.probeInfo.audioCodecName ?? "unknown"} sourceAudioRate=${session.probeInfo.audioSampleRate ?? "unknown"} audioPipeline=${session.audioPipeline ?? "none"} channels=${session.probeInfo.audioChannels ?? "unknown"}`
    );
  }
  let sawRelaySocketError = false;
  let relaySocketErrorCount = 0;
  let requestedDirectFallback = false;
  let sawDirectServer5xx = false;
  let requestedDirectVariantRetry = false;
  let requestedRelayFallback = false;
  let directSocketErrorCount = 0;
  let requestedDirectRestart = false;
  const ff = spawn(ffmpegExecutable, args, {
    cwd: session.dir,
    windowsHide: true
  });

  ff.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString().trim();
    if (message) {
      session.lastError = message;
      console.warn(`[transcode][ffmpeg][${session.id}][input=${effectiveInputMode}] ${message}`);
      if (effectiveInputMode === "relay" && message.includes("Error number -10053")) {
        sawRelaySocketError = true;
        relaySocketErrorCount += 1;

        if (allowDirectFallback && !session.hasTriedDirectInputFallback && !requestedDirectFallback && relaySocketErrorCount >= 2) {
          requestedDirectFallback = true;
          console.warn(`[transcode] session=${session.id} repeated relay socket errors (${relaySocketErrorCount}), forcing direct-input fallback`);
          try {
            ff.kill();
          } catch {
            // If kill fails, natural process exit path may still trigger fallback.
          }
        }
      }

      if (effectiveInputMode === "direct" && message.includes("Error number -10053")) {
        directSocketErrorCount += 1;

        if (!requestedDirectRestart && directSocketErrorCount >= 2 && session.directInputRestartCount < 3) {
          requestedDirectRestart = true;
          console.warn(`[transcode] session=${session.id} repeated direct socket errors (${directSocketErrorCount}), restarting direct input`);
          try {
            ff.kill();
          } catch {
            // If kill fails, exit handler may still run after natural process termination.
          }
        }
      }

      if (
        effectiveInputMode === "direct" &&
        (/Server returned 5XX Server Error reply/i.test(message) || /Server returned 5\d\d/i.test(message))
      ) {
        sawDirectServer5xx = true;

        if (!session.hasTriedRelayInputFallback && !requestedRelayFallback) {
          requestedRelayFallback = true;
          console.warn(
            `[transcode] session=${session.id} direct input returned upstream 5xx, switching to relay before direct variant retries`
          );
          try {
            ff.kill();
          } catch {
            // If kill fails, natural process exit path may still trigger fallback.
          }
          return;
        }
      }

      if (
        effectiveInputMode === "direct" &&
        /Stream ends prematurely/i.test(message) &&
        !session.hasTriedRelayInputFallback &&
        !requestedRelayFallback
      ) {
        requestedRelayFallback = true;
        console.warn(`[transcode] session=${session.id} direct input ended prematurely, switching to relay input`);
        try {
          ff.kill();
        } catch {
          // If kill fails, natural process exit path may still trigger fallback.
        }
      }

      if (
        effectiveInputMode === "relay" &&
        allowDirectFallback &&
        (/Server returned 5XX Server Error reply/i.test(message) || /Server returned 5\d\d/i.test(message))
      ) {
        if (!session.hasTriedDirectInputFallback && !requestedDirectFallback) {
          requestedDirectFallback = true;
          console.warn(`[transcode] session=${session.id} relay path returned upstream 5xx, retrying with direct input`);
          try {
            ff.kill();
          } catch {
            // If kill fails, natural process exit path may still trigger fallback.
          }
        }
      }
    }
  });

  ff.on("error", () => {
    session.ffmpegMissing = true;
    session.lastError = "Failed to start FFmpeg process";
    session.nextSpawnAllowedAt = Date.now() + TRANSCODE_RESPAWN_COOLDOWN_MS;
    session.proc = null;
  });

  ff.on("exit", (code, signal) => {
    if (
      (sawRelaySocketError || requestedDirectFallback) &&
      session.inputMode === "relay" &&
      !session.hasTriedDirectInputFallback
    ) {
      session.hasTriedDirectInputFallback = true;
      session.inputMode = "direct";
      session.lastError = null;
      session.proc = null;
      console.warn(`[transcode] session=${session.id} relay socket unstable (-10053), retrying with direct input`);
      startTranscoder(session);
      return;
    }

    if (requestedDirectRestart && session.inputMode === "direct" && session.directInputRestartCount < 3) {
      session.directInputRestartCount += 1;
      session.lastError = null;
      session.proc = null;
      setTimeout(() => {
        startTranscoder(session);
      }, 250);
      return;
    }

    if (requestedDirectVariantRetry && session.inputMode === "direct") {
      session.lastError = null;
      session.proc = null;
      setTimeout(() => {
        startTranscoder(session);
      }, 150);
      return;
    }

    if (
      (sawDirectServer5xx || requestedRelayFallback) &&
      session.inputMode === "direct" &&
      !session.hasTriedRelayInputFallback
    ) {
      session.hasTriedRelayInputFallback = true;
      session.inputMode = "relay";
      session.lastError = null;
      session.proc = null;
      console.warn(`[transcode] session=${session.id} switching to relay input after direct upstream 5xx`);
      startTranscoder(session);
      return;
    }

    if (code !== 0) {
      session.lastError = session.lastError || `FFmpeg exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`;
    }
    session.nextSpawnAllowedAt = sessionHasPlayableOutput(session)
      ? 0
      : Date.now() + TRANSCODE_RESPAWN_COOLDOWN_MS;
    if (sessionHasPlayableOutput(session)) {
      session.spawnWindowCount = 0;
      session.spawnWindowStartAt = Date.now();
    }
    session.proc = null;
  });

  session.ffmpegMissing = false;
  session.lastError = null;
  session.proc = ff;
  session.lastUsed = Date.now();
  session.nextSpawnAllowedAt = 0;
  session.profile = CURRENT_TRANSCODE_PROFILE;
}

function getOrCreateTranscodeSession(
  sourceUrl: string,
  audioEnabled: boolean,
  audioMode: AudioMode,
  host: string | undefined,
  sessionKeySalt?: string
): TranscodeSession {
  sourceUrl = normalizeProblematicLiveSourceUrl(sourceUrl);
  const preferRelayInput = shouldPreferRelayInput(sourceUrl);
  const id = getTranscodeSessionId(sourceUrl, audioEnabled, audioMode, sessionKeySalt);
  const existing = transcodeSessions.get(id);
  if (existing) {
    if (
      existing.profile !== CURRENT_TRANSCODE_PROFILE ||
      existing.audioEnabled !== audioEnabled ||
      existing.audioMode !== audioMode
    ) {
      if (existing.proc && !existing.proc.killed) {
        existing.proc.kill();
      }

      existing.proc = null;
      existing.ffmpegMissing = false;
      existing.lastError = null;
      existing.nextSpawnAllowedAt = 0;
      existing.spawnWindowStartAt = Date.now();
      existing.spawnWindowCount = 0;
      existing.profile = CURRENT_TRANSCODE_PROFILE;
      existing.audioEnabled = audioEnabled;
      existing.audioMode = audioMode;
    }

    // Re-apply input preference for resumed sessions.
    if (!existing.proc || existing.proc.killed) {
      const sourceChanged = existing.sourceUrl !== sourceUrl;
      existing.sourceUrl = sourceUrl;
      existing.inputMode = preferRelayInput ? "relay" : "direct";
      existing.hasTriedDirectInputFallback = preferRelayInput ? false : true;
      existing.hasTriedRelayInputFallback = preferRelayInput ? true : false;
      if (sourceChanged) {
        existing.movieInputAttempts = [sourceUrl];
      } else if (!existing.movieInputAttempts.length) {
        existing.movieInputAttempts = [sourceUrl];
      }
    }
    existing.directInputRestartCount = 0;
    existing.relaySourceUrl = toRelayInputUrl(host, sourceUrl);

    existing.lastUsed = Date.now();
    return existing;
  }

  const baseDir = getSessionDir(id);
  const dir = path.join(baseDir, "initial");
  const playlistPath = path.join(dir, "index.m3u8");
  const session: TranscodeSession = {
    id,
    sourceUrl,
    relaySourceUrl: toRelayInputUrl(host, sourceUrl),
    inputMode: preferRelayInput ? "relay" : "direct",
    hasTriedDirectInputFallback: preferRelayInput ? false : true,
    hasTriedRelayInputFallback: preferRelayInput ? true : false,
    directInputRestartCount: 0,
    audioEnabled,
    audioMode,
    audioPipeline: null,
    profile: CURRENT_TRANSCODE_PROFILE,
    movieInputAttempts: [sourceUrl],
    baseDir,
    dir,
    playlistPath,
    proc: null,
    ffmpegMissing: false,
    lastError: null,
    lastUsed: Date.now(),
    nextSpawnAllowedAt: 0,
    spawnWindowStartAt: Date.now(),
    spawnWindowCount: 0,
    probeInfo: getSourceProbeInfo(sourceUrl)
  };

  transcodeSessions.set(id, session);
  return session;
}

function contentTypeForFile(fileName: string): string {
  if (fileName.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (fileName.endsWith(".ts")) return "video/mp2t";
  if (fileName.endsWith(".m4s")) return "video/iso.segment";
  if (fileName.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function getTranscodeFileWaitMs(fileName: string): number {
  if (fileName === "index.m3u8") return TRANSCODE_MANIFEST_WAIT_MS;
  if (fileName === "init.mp4") return TRANSCODE_INIT_WAIT_MS;
  return TRANSCODE_SEGMENT_WAIT_MS;
}

function sessionHasPlayableOutput(session: TranscodeSession): boolean {
  try {
    if (!fs.existsSync(session.playlistPath)) return false;
    const files = fs.readdirSync(session.dir);
    return files.some((name) => /^seg_\d+\.(ts|m4s)$/i.test(name));
  } catch {
    return false;
  }
}

function relayTargetUrl(targetUrl: string): string {
  return `${RELAY_PATH}?url=${encodeURIComponent(targetUrl)}`;
}

function rewriteManifestLine(line: string, manifestUrl: string): string {
  const trimmed = line.trim();
  if (!trimmed) return line;

  if (trimmed.startsWith("#")) {
    if (trimmed.startsWith("#EXT-X-KEY") || trimmed.startsWith("#EXT-X-MAP")) {
      return line.replace(/URI="([^"]+)"/, (_, uri: string) => {
        try {
          const absolute = new URL(uri, manifestUrl).toString();
          return `URI="${relayTargetUrl(absolute)}"`;
        } catch {
          return `URI="${uri}"`;
        }
      });
    }
    return line;
  }

  try {
    const absolute = new URL(trimmed, manifestUrl).toString();
    return relayTargetUrl(absolute);
  } catch {
    return line;
  }
}

function isLikelyManifest(contentType: string | string[] | undefined, targetUrl: string): boolean {
  const type = Array.isArray(contentType) ? contentType.join(";") : contentType || "";
  const lowerType = type.toLowerCase();
  if (lowerType.includes("mpegurl") || lowerType.includes("vnd.apple.mpegurl")) {
    return true;
  }

  return /\.m3u8(\?|$)/i.test(targetUrl);
}

function getMovieVariantFallbackUrls(targetUrl: string, statusCode?: number): string[] {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return [];
  }

  const pathname = parsed.pathname;
  const match = pathname.match(/^(.*\/movie\/[^/]+\/[^/]+\/\d+)\.(mp4|mkv|ts|m3u8)$/i);
  if (!match) return [];

  const [, basePath, currentExtRaw] = match;
  const currentExt = currentExtRaw.toLowerCase();
  // For VOD, providers more commonly serve file-container variants (mkv/mp4)
  // than transport/HLS endpoints. Try those first to reduce upstream 5xx/551 loops.
  // Some providers return 551 specifically for HLS probes; in that case skip m3u8.
  const extensionOrder = statusCode === 551
    ? ["mkv", "mp4", "ts"]
    : ["mkv", "mp4", "ts", "m3u8"];
  const alternatives = extensionOrder.filter((ext) => ext !== currentExt);

  const variantUrls = alternatives.map((ext) => {
    const next = new URL(parsed.toString());
    next.pathname = `${basePath}.${ext}`;
    return next.toString();
  });

  // Some Xtream providers accept extension-less movie paths for VOD where
  // extension-specific routes return upstream 55x.
  const extensionless = new URL(parsed.toString());
  extensionless.pathname = basePath;

  return [...variantUrls, extensionless.toString()];
}

function parseMovieVariant(targetUrl: string): { basePath: string; ext: string; url: URL } | null {
  try {
    const parsed = new URL(targetUrl);
    const match = parsed.pathname.match(/^(.*\/movie\/[^/]+\/[^/]+\/\d+)\.(mp4|mkv|ts|m3u8)$/i);
    if (!match) return null;

    return {
      basePath: match[1],
      ext: match[2].toLowerCase(),
      url: parsed
    };
  } catch {
    return null;
  }
}

async function fetchAndRelay(
  targetUrl: string,
  res: http.ServerResponse,
  redirectDepth = 0,
  attemptedUrls = new Set<string>()
): Promise<void> {
  if (attemptedUrls.has(targetUrl)) {
    res.statusCode = 502;
    res.end("Relay upstream retry loop detected");
    return;
  }
  attemptedUrls.add(targetUrl);

  if (redirectDepth > REDIRECT_LIMIT) {
    res.statusCode = 508;
    res.end("Too many upstream redirects");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    res.statusCode = 400;
    res.end("Invalid target URL");
    return;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.statusCode = 400;
    res.end("Only http(s) URLs are supported");
    return;
  }

  // Fast-path cached variant for known problematic movie IDs.
  const movieVariant = parseMovieVariant(parsed.toString());
  if (movieVariant) {
    const cachedExt = movieVariantCache.get(movieVariant.basePath);
    if (cachedExt && cachedExt !== movieVariant.ext) {
      const cachedUrl = new URL(movieVariant.url.toString());
      cachedUrl.pathname = `${movieVariant.basePath}.${cachedExt}`;
      const cachedTarget = cachedUrl.toString();
      if (!attemptedUrls.has(cachedTarget)) {
        void fetchAndRelay(cachedTarget, res, redirectDepth, attemptedUrls);
        return;
      }
    }
  }

  const client = parsed.protocol === "https:" ? https : http;
  const upstream = client.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      rejectUnauthorized: false,
      minVersion: "TLSv1",
      // Some IPTV providers still require legacy cipher suites.
      ciphers: "DEFAULT:@SECLEVEL=0",
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
      servername: parsed.hostname,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 IPTVmate/1.0",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        referer: `${parsed.protocol}//${parsed.host}/`,
        origin: `${parsed.protocol}//${parsed.host}`
      }
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const location = upstreamRes.headers.location;

      if (status >= 300 && status < 400 && location) {
        const nextUrl = new URL(location, parsed.toString()).toString();
        void fetchAndRelay(nextUrl, res, redirectDepth + 1, attemptedUrls);
        upstreamRes.resume();
        return;
      }

      if (status >= 500) {
        const fallbacks = getMovieVariantFallbackUrls(parsed.toString(), status);
        const nextFallback = fallbacks.find((candidate) => !attemptedUrls.has(candidate));
        if (nextFallback) {
          console.warn(`[relay] upstream ${status} for ${parsed.toString()} -> retrying ${nextFallback}`);
          upstreamRes.resume();
          void fetchAndRelay(nextFallback, res, redirectDepth, attemptedUrls);
          return;
        }
      }

      if (status >= 200 && status < 300) {
        const resolvedMovieVariant = parseMovieVariant(parsed.toString());
        if (resolvedMovieVariant) {
          if (resolvedMovieVariant.ext !== "m3u8") {
            movieVariantCache.set(resolvedMovieVariant.basePath, resolvedMovieVariant.ext);
          }
        }
      }

      const contentType = upstreamRes.headers["content-type"];
      const shouldRewriteManifest = isLikelyManifest(contentType, parsed.toString());

      res.statusCode = status;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");

      if (contentType) {
        res.setHeader("Content-Type", contentType);
      }

      if (!shouldRewriteManifest) {
        upstreamRes.pipe(res);
        return;
      }

      let manifest = "";
      upstreamRes.setEncoding("utf8");
      upstreamRes.on("data", (chunk) => {
        manifest += chunk;
      });
      upstreamRes.on("end", () => {
        const rewritten = manifest
          .split(/\r?\n/)
          .map((line) => rewriteManifestLine(line, parsed.toString()))
          .join("\n");
        res.end(rewritten);
      });
    }
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`Relay upstream error: ${err.message}`);
      return;
    }

    res.end();
  });

  upstream.setTimeout(30000, () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.statusCode = 504;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Relay upstream timeout");
    }
  });

  upstream.end();
}

function streamRelayMiddleware(req: http.IncomingMessage, res: http.ServerResponse, next: () => void) {
  if (!req.url) {
    next();
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");
  if (requestUrl.pathname !== RELAY_PATH) {
    next();
    return;
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.end();
    return;
  }

  const targetUrl = requestUrl.searchParams.get("url");
  if (!targetUrl) {
    res.statusCode = 400;
    res.end("Missing url query parameter");
    return;
  }

  void fetchAndRelay(targetUrl, res);
}

function transcodeMiddleware(req: http.IncomingMessage, res: http.ServerResponse, next: () => void) {
  if (!req.url) {
    next();
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");
  if (!requestUrl.pathname.startsWith(TRANSCODE_PATH)) {
    next();
    return;
  }

  reapStaleTranscodeSessions();

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.end();
    return;
  }

  const pathSuffix = requestUrl.pathname.slice(TRANSCODE_PATH.length);

  if (!pathSuffix || pathSuffix === "/") {
    const requestedSourceUrl = requestUrl.searchParams.get("url");
    const audioEnabled = requestUrl.searchParams.get("audio") !== "0";
    const rawAudioMode = requestUrl.searchParams.get("amode");
    const audioMode: AudioMode =
      rawAudioMode === "compat" ? "compat" : rawAudioMode === "safe" ? "safe" : "standard";
    if (!requestedSourceUrl) {
      res.statusCode = 400;
      res.end("Missing url query parameter");
      return;
    }

    let sourceUrl = normalizeProblematicLiveSourceUrl(requestedSourceUrl);
    sourceUrl = normalizeProblematicVodSourceUrl(sourceUrl);
    const isVodBootstrapTarget = /\/(movie|series)\//i.test(sourceUrl) || /%2F(movie|series)%2F/i.test(sourceUrl);
    const normalizedAudioMode: AudioMode =
      audioEnabled && isVodBootstrapTarget && audioMode === "standard" ? "compat" : audioMode;

    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      res.statusCode = 400;
      res.end("Invalid source url");
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      res.statusCode = 400;
      res.end("Only http(s) URLs are supported");
      return;
    }

    const sessionKeySalt =
      audioEnabled && isVodBootstrapTarget
        ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : undefined;
    const session = getOrCreateTranscodeSession(
      sourceUrl,
      audioEnabled,
      normalizedAudioMode,
      req.headers.host,
      sessionKeySalt
    );
    if (shouldPreferRelayInput(sourceUrl)) {
      session.inputMode = "relay";
      session.hasTriedDirectInputFallback = false;
      session.hasTriedRelayInputFallback = true;
    } else {
      // Reset any stale relay-mode state for non-live sessions so each new
      // playback attempt starts direct-first.
      const wasRelay = session.inputMode === "relay";
      session.inputMode = "direct";
      session.hasTriedDirectInputFallback = true;
      session.hasTriedRelayInputFallback = false;
      if (wasRelay && session.proc && !session.proc.killed) {
        try {
          session.proc.kill();
        } catch {
          // Ignore kill errors; startTranscoder() will handle current process state.
        }
        session.proc = null;
      }
    }
    session.relaySourceUrl = toRelayInputUrl(req.headers.host, sourceUrl);
    startTranscoder(session);

    if (session.ffmpegMissing) {
      res.statusCode = 501;
      res.end("FFmpeg not found on PATH. Install ffmpeg to enable transcoding.");
      return;
    }

    res.statusCode = 302;
    const entryPlaylist = audioEnabled ? "master.m3u8" : "index.m3u8";
    const pipelineSuffix = "";
    res.setHeader(
      "Location",
      `${TRANSCODE_PATH}/session/${session.id}/${entryPlaylist}${pipelineSuffix}`
    );
    res.end();
    return;
  }

  const sessionMatch = pathSuffix.match(/^\/session\/([a-f0-9]{16})\/(.+)$/);
  if (!sessionMatch) {
    res.statusCode = 404;
    res.end("Unknown transcode route");
    return;
  }

  const [, sessionId, rawFile] = sessionMatch;
  const safeFile = path.basename(rawFile);
  const session = transcodeSessions.get(sessionId);
  if (!session) {
    res.statusCode = 404;
    res.end("Unknown transcode session");
    return;
  }

  const isVodSession = /\/(movie|series)\//i.test(session.sourceUrl) || /%2F(movie|series)%2F/i.test(session.sourceUrl);
  const isPlaylistFile = safeFile === "master.m3u8" || safeFile === "index.m3u8";
  if (session.audioEnabled && isVodSession && session.audioMode === "standard" && isPlaylistFile) {
    const compatSession = getOrCreateTranscodeSession(
      session.sourceUrl,
      true,
      "compat",
      req.headers.host,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    );
    compatSession.relaySourceUrl = toRelayInputUrl(req.headers.host, compatSession.sourceUrl);
    startTranscoder(compatSession);
    res.statusCode = 302;
    res.setHeader("Location", `${TRANSCODE_PATH}/session/${compatSession.id}/${safeFile}`);
    res.end();
    return;
  }

  session.relaySourceUrl = toRelayInputUrl(req.headers.host, session.sourceUrl);
  if (shouldPreferRelayInput(session.sourceUrl)) {
    session.inputMode = "relay";
    session.hasTriedDirectInputFallback = false;
    session.hasTriedRelayInputFallback = true;
  }
  if ((!session.proc || session.proc.killed) && !sessionHasPlayableOutput(session)) {
    startTranscoder(session);
  }

  if (session.ffmpegMissing) {
    res.statusCode = 501;
    res.end("FFmpeg unavailable");
    return;
  }

  session.lastUsed = Date.now();

  // Serve a synthetic master playlist that declares both video and audio codecs.
  // This forces hls.js to demux both streams from the transcoded MPEG-TS segments
  // even though the media playlist itself has no codec declaration.
  if (safeFile === "master.m3u8") {
    if (!session.audioEnabled) {
      res.statusCode = 404;
      res.end("Master playlist only available for audio-enabled sessions");
      return;
    }

    const bandwidth = session.audioMode === "safe" ? 1500000 : session.audioMode === "compat" ? 1700000 : 2000000;
    // Declare an explicit AUDIO rendition group so stricter TV players bind
    // audio tracks deterministically instead of relying on implicit muxed-track detection.
    const transcodedAudioMediaLine =
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Stereo",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="eng",URI="index.m3u8"';
    const transcodedCodecLine = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth},CODECS="avc1.4d4028,mp4a.40.2",FRAME-RATE=30,AUDIO="audio"`;
    const masterPlaylist = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      transcodedAudioMediaLine,
      transcodedCodecLine,
      "index.m3u8",
      ""
    ].join("\n");

    res.statusCode = 200;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.end(masterPlaylist);
    return;
  }

  const waitUntil = Date.now() + getTranscodeFileWaitMs(safeFile);
  const tryServe = () => {
    const activeDir = session.dir;
    const fullPath = path.join(activeDir, safeFile);

    if (!fullPath.startsWith(activeDir)) {
      res.statusCode = 403;
      res.end("Invalid file path");
      return;
    }

    if (fs.existsSync(fullPath)) {
      console.log(`[transcode-serve] session=${sessionId} file=${safeFile} run=${path.basename(activeDir)} exists=true size=${fs.statSync(fullPath).size}`);
      res.statusCode = 200;
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", contentTypeForFile(safeFile));

      // Strip leading #EXT-X-DISCONTINUITY tags from media playlists for
      // VOD-like sessions. FFmpeg inserts one at pos 0 when it resets timestamps
      // via -avoid_negative_ts make_zero, which confuses Hls.js into stalling.
      const isMediaPlaylist = safeFile === "index.m3u8";
      const isVodSession = /\/(movie|series)\//i.test(session.sourceUrl);
      if (isMediaPlaylist && isVodSession) {
        try {
          const raw = fs.readFileSync(fullPath, "utf8");
          // Remove #EXT-X-DISCONTINUITY lines that appear before the first segment URL.
          const firstSegIdx = raw.search(/^seg_/m);
          if (firstSegIdx > 0) {
            const header = raw.slice(0, firstSegIdx).replace(/^#EXT-X-DISCONTINUITY\r?\n/gm, "");
            let cleaned = header + raw.slice(firstSegIdx);

            // Some VOD encodes produce ~2.5s segments while FFmpeg keeps
            // #EXT-X-TARGETDURATION at 2, which can cause clients to reload
            // playlists without progressing to segment playback.
            const extInfDurations = Array.from(cleaned.matchAll(/#EXTINF:([0-9]+(?:\.[0-9]+)?)/g))
              .map((match) => Number(match[1]))
              .filter((duration) => Number.isFinite(duration) && duration > 0);
            if (extInfDurations.length > 0) {
              const normalizedTarget = Math.ceil(Math.max(...extInfDurations));
              if (/^#EXT-X-TARGETDURATION:\d+/m.test(cleaned)) {
                cleaned = cleaned.replace(/^#EXT-X-TARGETDURATION:\d+/m, `#EXT-X-TARGETDURATION:${normalizedTarget}`);
              }
            }

            console.log(`[transcode-serve] session=${sessionId} file=${safeFile} stripped-discontinuity=true lines=${cleaned.split('\n').length}`);
            res.end(cleaned);
            return;
          }
        } catch {
          // Fall through to stream if read fails.
        }
      }

      console.log(`[transcode-serve] session=${sessionId} file=${safeFile} run=${path.basename(activeDir)} piping=${true}`);
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

     if (Date.now() >= waitUntil) {
      console.log(`[transcode-serve] session=${sessionId} file=${safeFile} run=${path.basename(activeDir)} timeout exists=${fs.existsSync(fullPath)}`);
     }
    if (Date.now() < waitUntil) {
      setTimeout(tryServe, 60);
      return;
    }

    if (!session.proc && session.lastError) {
      res.statusCode = 502;
      res.end(`Transcoder error: ${session.lastError}`);
      return;
    }

    res.statusCode = session.ffmpegMissing ? 501 : 504;
    res.end(session.ffmpegMissing ? "FFmpeg unavailable" : "Transcoded stream not ready");
  };

  tryServe();
}

export default defineConfig({
  base: "./",
  plugins: [
    react({ fastRefresh: false }),
    {
      name: "iptvmate-stream-relay",
      configureServer(server) {
        server.middlewares.use(streamRelayMiddleware);
        server.middlewares.use(transcodeMiddleware);
      },
      configurePreviewServer(server) {
        server.middlewares.use(streamRelayMiddleware);
        server.middlewares.use(transcodeMiddleware);
      }
    }
  ],
  build: {
    outDir: "dist"
  },
  server: {
    hmr: false
  }
});
