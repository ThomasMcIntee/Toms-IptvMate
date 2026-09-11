export type PlaybackAudioTrack = {
  id: string;
  language: string;
  label: string;
  selected: boolean;
};

const AUDIO_LANGUAGE_KEY = "iptvmate_audio_language";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  ar: "العربية",
  hi: "हिन्दी",
  ru: "Русский",
  tr: "Türkçe",
  pl: "Polski",
  nl: "Nederlands",
  ja: "日本語",
  ko: "한국어",
  zh: "中文"
};

export function normalizeAudioLanguage(language: string | null | undefined): string {
  const raw = String(language || "").trim().toLowerCase().split(/[-_]/)[0];
  if (!raw) return "";
  switch (raw) {
    case "eng":
      return "en";
    case "spa":
    case "esp":
      return "es";
    case "fra":
    case "fre":
      return "fr";
    case "deu":
    case "ger":
      return "de";
    case "ita":
      return "it";
    case "por":
      return "pt";
    case "ara":
      return "ar";
    case "hin":
      return "hi";
    case "rus":
      return "ru";
    case "tur":
      return "tr";
    case "pol":
      return "pl";
    case "nld":
    case "dut":
      return "nl";
    case "jpn":
      return "ja";
    case "kor":
      return "ko";
    case "zho":
    case "chi":
      return "zh";
    default:
      return raw;
  }
}

export function audioLanguagesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeAudioLanguage(left);
  const b = normalizeAudioLanguage(right);
  return !!a && a === b;
}

export function audioLanguageLabel(language: string | null | undefined, fallback = ""): string {
  const code = normalizeAudioLanguage(language);
  if (!code) return fallback;
  return LANGUAGE_NAMES[code] || code.toUpperCase();
}

export function readPreferredAudioLanguage(): string {
  try {
    return normalizeAudioLanguage(localStorage.getItem(AUDIO_LANGUAGE_KEY));
  } catch {
    return "";
  }
}

export function savePreferredAudioLanguage(language: string | null | undefined): void {
  const code = String(language || "").trim();
  if (!code) return;
  try {
    localStorage.setItem(AUDIO_LANGUAGE_KEY, code);
  } catch {
    // Keep the in-memory selection when storage is unavailable.
  }
}

export function preferredAudioTrackIndex<T extends { language?: string; default?: boolean }>(
  tracks: T[],
  preferredLanguage = readPreferredAudioLanguage()
): number {
  if (!tracks.length) return -1;
  if (preferredLanguage) {
    const preferred = tracks.findIndex((track) => audioLanguagesMatch(track.language, preferredLanguage));
    if (preferred >= 0) return preferred;
  }
  const defaultIndex = tracks.findIndex((track) => track.default);
  return defaultIndex >= 0 ? defaultIndex : 0;
}
