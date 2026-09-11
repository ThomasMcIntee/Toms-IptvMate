/* @refresh reload */

import { startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChannelList } from "./ui/ChannelList";
import { EPGGrid } from "./ui/EPGGrid";
import { PanelsHost } from "./ui/PanelsHost";
import { firstGroupForMasterKey, MasterMinList } from "./ui/MasterMinList";
import { useProfile } from "./profiles/ProfileContext";
import { initNavigation } from "./core/navigation";
import { activateFocusedRemoteControl, beginComposerTextEdit, normalizeRemoteMediaKey, normalizeRemoteNavKey, resetComposerTextEditGuard } from "./core/remoteKeys";
import { initPlayerEngine, playUrl, stopPlayback } from "./core/playerEngine";
import {
  isNativePlayerAvailable,
  isNativePlaybackMuted,
  isNativePlaybackPaused,
  noteNativePlaybackMuted,
  noteNativePlaybackPaused,
  pauseNativePlayback,
  playNativeUrl,
  resumeNativePlayback,
  revealNativePlayerControls,
  focusNativePlayerControls,
  setNativeMuted,
  stopNativePlayback,
  syncNativePlayerBounds,
  exitNativeApp
} from "./core/nativePlayerBridge";
import { isCapacitorRuntime, isWebOsRuntime } from "./core/player/platformDetection";
import { exitWebOsApp } from "./core/webosExit";
import { GroupList } from "./ui/GroupList";
import { isRemoteTextComposerOpen } from "./ui/RemoteTextComposer";
import { sortChannelsByName, type GroupSortDirection, type ItemSortDirection } from "./ui/groupSorting";
import {
  getAllChannels,
  getGroups,
  isFavoriteChannelRecord,
  isChannelVisible,
  isGroupVisible,
  applyVisibilitySnapshotForCurrentChannels,
  getLastChannelWriteTrace,
  resetVisibilityForCurrentChannels,
  restoreLiveVisibility,
  restoreChannelsCache,
  hydrateCachedVodScope,
  setChannelFavoriteRecord,
  setChannelVisible,
  setChannels,
  trimCapacitorChannelMemoryForLive,
  releaseCapacitorMemoryForLivePlayback,
  getCapacitorLiveGroupNames,
  getCapacitorLiveGroupCounts,
  loadCapacitorLiveGroupChannels,
  loadCapacitorFavoriteChannels,
  getCapacitorVodGroupNames,
  getCapacitorVodGroupCounts,
  loadCapacitorVodGroupChannels,
  loadCapacitorVodFavoriteChannels,
  countCapacitorFavoriteRecords,
  searchCapacitorVodCatalog,
  scheduleCapacitorLegacyCachePurge,
  loadCapacitorVodScopeCache,
  saveCapacitorVodScopeCache,
  capCapacitorCatalogList,
  pruneCapacitorVisibilityIfBloated,
  setRoleChannelWriteLock,
  setGroupVisible,
  setGroupsVisible,
  setActiveVisibilityRole,
  visibilityScopeFromChannel,
  type ChannelVisibilitySnapshot
} from "./core/channelStore";
import NowNextOverlay from "./ui/NowNextOverlay";
import { PlayerControlBar, VodExitButton, VodLanguageSelect } from "./ui/PlayerControlBar";
import { isAudioLanguagePickerOpen, setAudioLanguagePickerOpen } from "./core/audioTracks";
import { LAST_WATCHED_GROUP, recordLastWatched, resolveLastWatchedChannels } from "./core/lastWatched";
import { VodResumePrompt } from "./ui/VodResumePrompt";
import {
  clearVodResume,
  getVodResume,
  readVideoPlaybackPosition,
  saveVodResume,
  shouldOfferVodResume
} from "./core/vodResume";
import { isPlaylistsHydrationPending, loadPlaylists, type PlaylistEntry } from "./core/playlistStore";
import { loadEPGForPlaylist } from "./core/loaders/epgLoader";
import { getEPG, getEPGForChannel, getIndexedEPGForChannel, setEPG } from "./core/epgStore";
import {
  extractMasterBouquetKey,
  getMasterMinListVersion,
  groupMatchesMasterMinList,
  hasMasterMinList,
  subscribeMasterMinList
} from "./core/masterMinList";
import { loadRecordings } from "./core/recordingEngine";
import MainMenuScreen from "./ui/MainMenuScreen";
import { loadChannelsForPlaylist } from "./core/loaders/playlistLoader";
import { loadXtream, loadXtreamSeriesBundleFromChannel, loadXtreamSeriesEpisodesFromChannel, loadXtreamVodInfoFromChannel, type XtreamSeriesInfo, type XtreamVodInfo } from "./core/loaders/xtreamLoader";
import { loadXtreamEPGForStream } from "./core/loaders/xtreamEPG";
import { getBackgroundConcurrency, waitForBackgroundSlot, yieldToMain } from "./core/taskScheduler";
import SeriesEpisodePicker from "./ui/SeriesEpisodePicker";
import SeriesDetailsScreen from "./ui/SeriesDetailsScreen";
import MovieDetailsScreen from "./ui/MovieDetailsScreen";

const ROOT_GROUP = "Favorites";
const MAX_SERIES_SEARCH_RESULTS = 800;
const MAX_WEAK_SEARCH_RESULTS = 240;
const SERIES_SEARCH_MIN_TERM_LENGTH = 1;
const SERIES_LAST_WATCH_KEY = "iptvmate_series_last_watch";
const SERIES_SEARCH_KEY_ROWS = [
  ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
  ["J", "K", "L", "M", "N", "O", "P", "Q", "R"],
  ["S", "T", "U", "V", "W", "X", "Y", "Z", "0"],
  ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
];

type AccessLevel = "master" | "adult" | "child" | null;

const ADULT_ROLE_CACHE_KEY = "iptvmate_adult_channels_cache";
const CHILD_ROLE_CACHE_KEY = "iptvmate_child_channels_cache";
const ADULT_PLAYLIST_ID_KEY = "iptvmate_adult_playlist_id";
const CHILD_PLAYLIST_ID_KEY = "iptvmate_child_playlist_id";
const SHARED_PLAYLIST_ID_KEY = "iptvmate_shared_playlist_id";
const MOVIES_SORT_DIRECTION_KEY = "iptvmate_movies_sort_direction";
const SERIES_SORT_DIRECTION_KEY = "iptvmate_series_sort_direction";
const GROUP_SORT_DIRECTION_KEY = "iptvmate_group_sort_direction";

function friendlyPlaybackError(message?: string | null): string {
  const raw = String(message || "").trim();
  const lower = raw.toLowerCase();
  if (
    /hevc|h265|hvc1|hev1/.test(lower) ||
    (/mkv|matroska/.test(lower) && /cannot|fail|unsupported|format_supported=no|mediacodec/.test(lower))
  ) {
    return "This Android TV emulator cannot play HEVC/MKV. Trying MP4, or play this title on a real Fire TV.";
  }
  return raw;
}

function readStoredItem(key: string): string | null {
  try {
    const local = localStorage.getItem(key);
    if (local) return local;
  } catch {
    // Ignore localStorage access errors.
  }

  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage access errors.
  }

  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore sessionStorage access errors.
  }
}

function resolveStoredPlaylistId(playlists: PlaylistEntry[] = loadPlaylists()): string {
  const stored = (
    readStoredItem(SHARED_PLAYLIST_ID_KEY) ||
    readStoredItem(ADULT_PLAYLIST_ID_KEY) ||
    readStoredItem(CHILD_PLAYLIST_ID_KEY) ||
    ""
  ).trim();
  if (stored && (playlists.length === 0 || playlists.some((playlist) => playlist.id === stored))) {
    return stored;
  }
  return playlists[0]?.id || stored || "";
}

function isTextEntryActive(target: EventTarget | null = document.activeElement): boolean {
  if (typeof document !== "undefined" && document.body?.dataset?.webosKeyboard === "open") {
    return true;
  }
  return isTextEntryTarget(target) || isTextEntryTarget(document.activeElement);
}

function isPlaylistEditFieldButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains("playlist-edit-field-btn");
}

function isTextEraseKey(event: KeyboardEvent): boolean {
  const key = String(event.key || "");
  if (key === "Backspace" || key === "Delete") return true;
  const keyCode = Number((event as unknown as { keyCode?: number }).keyCode || 0);
  return keyCode === 8 || keyCode === 46 || keyCode === 67;
}

function isHardwareBackKeyEvent(event: KeyboardEvent): boolean {
  const key = String(event.key || "");
  if (
    key === "Escape" ||
    key === "BrowserBack" ||
    key === "GoBack" ||
    key === "Back" ||
    key === "XF86Back"
  ) {
    return true;
  }
  const keyCode = Number((event as unknown as { keyCode?: number }).keyCode || 0);
  return keyCode === 4 || keyCode === 27 || keyCode === 461 || keyCode === 10009;
}

function isBackKeyEvent(event: KeyboardEvent): boolean {
  if (isHardwareBackKeyEvent(event)) return true;
  const key = String(event.key || "");
  if (key === "Backspace" || key === "Return") return true;
  const keyCode = Number((event as unknown as { keyCode?: number }).keyCode || 0);
  return keyCode === 8;
}

function dismissActiveTextEntry(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    active.blur();
    return true;
  }
  return false;
}

export function App({ bootAction = null }: { bootAction?: string | null } = {}) {
  useEffect(() => {
    if (!isCapacitorRuntime()) {
      loadRecordings();
    }
  }, []);

  const { profile } = useProfile();
  const [contentPage, setContentPage] = useState<"live" | "movies" | "series" | "playlistManager">("live");
  const [currentChannel, setCurrentChannel] = useState<any | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerStatus, setPlayerStatus] = useState<string | null>(null);
  // Preserve the picture-only fallback notice after playback resumes.
  const [playerWarning, setPlayerWarning] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [showNowNext, setShowNowNext] = useState(false);
  const [showOpeningScreen, setShowOpeningScreen] = useState(!bootAction);
  const [categoryRefreshTick, setCategoryRefreshTick] = useState(0);
  const [channelUpdateTick, setChannelUpdateTick] = useState(0);  // Track channel data changes separately
  const [favoritesRefreshTick, setFavoritesRefreshTick] = useState(0);
  const [lastWatchedRefreshTick, setLastWatchedRefreshTick] = useState(0);
  const [activeGroup, setActiveGroup] = useState(ROOT_GROUP);
  const [selectedMasterKey, setSelectedMasterKey] = useState<string | null>(null);
  const [contentMode, setContentMode] = useState<"tv" | "movies" | "series">("tv");
  const [showLiveMenu, setShowLiveMenu] = useState(true);
  const [hasSelectedLiveChannel, setHasSelectedLiveChannel] = useState(false);
  const [isFullscreenActive, setIsFullscreenActive] = useState(false);
  const [isLiveFullscreenRequested, setIsLiveFullscreenRequested] = useState(false);
  const [playerUiTick, setPlayerUiTick] = useState(0);
  const [isSeriesPickerVisible, setIsSeriesPickerVisible] = useState(false);
  const [seriesPickerLoading, setSeriesPickerLoading] = useState(false);
  const [seriesPickerError, setSeriesPickerError] = useState<string | null>(null);
  const [seriesPickerTitle, setSeriesPickerTitle] = useState("");
  const [seriesPickerEpisodes, setSeriesPickerEpisodes] = useState<any[]>([]);
  const [seriesPickerSourceChannel, setSeriesPickerSourceChannel] = useState<any | null>(null);
  const [isSeriesDetailsVisible, setIsSeriesDetailsVisible] = useState(false);
  const [seriesDetailsChannel, setSeriesDetailsChannel] = useState<any | null>(null);
  const [seriesDetailsInfo, setSeriesDetailsInfo] = useState<XtreamSeriesInfo | null>(null);
  const [seriesDetailsLoading, setSeriesDetailsLoading] = useState(false);
  const seriesDetailsTokenRef = useRef(0);
  const [isSeriesSearchComposerOpen, setIsSeriesSearchComposerOpen] = useState(false);
  const [isMoviesSearchComposerOpen, setIsMoviesSearchComposerOpen] = useState(false);
  const composerOpenedAtRef = useRef(0);
  const seriesDraftRef = useRef("");
  const moviesDraftRef = useRef("");
  const [seriesMainSearchDraft, setSeriesMainSearchDraft] = useState("");
  const [seriesMainSearchDebouncedTerm, setSeriesMainSearchDebouncedTerm] = useState("");
  const [seriesMainSearchResults, setSeriesMainSearchResults] = useState<any[] | null>(null);
  const [moviesMainSearchTerm, setMoviesMainSearchTerm] = useState("");
  const [moviesMainSearchDraft, setMoviesMainSearchDraft] = useState("");
  const [moviesMainSearchResults, setMoviesMainSearchResults] = useState<any[] | null>(null);
  const [moviesSearchBusy, setMoviesSearchBusy] = useState(false);
  const [moviesSortDirection, setMoviesSortDirection] = useState<ItemSortDirection>(() => {
    try {
      const saved = localStorage.getItem(MOVIES_SORT_DIRECTION_KEY);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Ignore localStorage errors
    }
    return null;
  });
  const [groupSortDirection, setGroupSortDirection] = useState<GroupSortDirection>(() => {
    try {
      const saved = localStorage.getItem(GROUP_SORT_DIRECTION_KEY);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Ignore localStorage errors
    }
    return null;
  });
  const [seriesSortDirection, setSeriesSortDirection] = useState<ItemSortDirection>(() => {
    try {
      const saved = localStorage.getItem(SERIES_SORT_DIRECTION_KEY);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Ignore localStorage errors
    }
    return null;
  });
  const [accessLevel, setAccessLevel] = useState<AccessLevel>(null);
  const [loginCodeInput, setLoginCodeInput] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [activePlaylistId, setActivePlaylistId] = useState("");
  const [hasPlaylists, setHasPlaylists] = useState(false);
  const [playlistsRevision, setPlaylistsRevision] = useState(0);
  const activePlaylistIdRef = useRef(activePlaylistId);
  const accessLevelRef = useRef<AccessLevel>(accessLevel);
  const autoLoadTokenRef = useRef(0);
  const liveRoleRestoreAttemptRef = useRef("");
  const isLiveContentPage = !showOpeningScreen && contentPage === "live";
  const isLiveTvView = isLiveContentPage && activePanel === null;
  const isMoviesPage = !showOpeningScreen && contentPage === "movies";
  const isSeriesPage = !showOpeningScreen && contentPage === "series";
  const isPlaylistManagerPage = !showOpeningScreen && contentPage === "playlistManager";
  const isPlaylistManagerMoviesMode = isPlaylistManagerPage && contentMode === "movies";
  const isPlaylistManagerSeriesMode = isPlaylistManagerPage && contentMode === "series";
  const isMainMoviesScreen = !showOpeningScreen && isMoviesPage;
  const isMainSeriesScreen =
    !showOpeningScreen && isSeriesPage && !isSeriesPickerVisible && !isSeriesDetailsVisible;
  const isEpgSearchPanelOpen = activePanel === "epgSearch";
  const isContentIconsView = isMoviesPage || isSeriesPage || isLiveTvView;
  const isPlaylistInputPanelOpen = activePanel === "playlist";
  const isMovieOrSeriesSelected =
    !!currentChannel &&
    (matchesContentMode(currentChannel, "movies") || matchesContentMode(currentChannel, "series"));
  const isVodPlaybackFullscreen =
    !showOpeningScreen &&
    isMovieOrSeriesSelected &&
    (isMoviesPage || isSeriesPage || isPlaylistManagerMoviesMode || isPlaylistManagerSeriesMode);
  const showContentPreviewWindow =
    !showOpeningScreen &&
    isMovieOrSeriesSelected &&
    (isPlaylistManagerMoviesMode || isPlaylistManagerSeriesMode);
  const isEffectiveLiveFullscreen =
    contentPage === "live" && (isFullscreenActive || isLiveFullscreenRequested);
  const isLivePreviewFullscreen =
    isEffectiveLiveFullscreen && contentPage === "live" && hasSelectedLiveChannel && !!currentChannel;
  const forceLivePreviewLayout = !showOpeningScreen && contentPage === "live" && !hasSelectedLiveChannel;
  const shouldRenderMainVideo =
    !showOpeningScreen &&
    !isPlaylistInputPanelOpen &&
    !isEpgSearchPanelOpen &&
    (!!currentChannel || hasSelectedLiveChannel);
  const useLivePreviewShell = shouldRenderMainVideo && contentPage === "live";
  const useVodPlaybackShell = shouldRenderMainVideo && isVodPlaybackFullscreen;
  const isLiveChannelPlaying =
    !showOpeningScreen &&
    !!currentChannel &&
    matchesContentMode(currentChannel, "tv") &&
    contentPage === "live";
  const currentChannelRef = useRef<any | null>(null);
  const suppressPlayerEventsRef = useRef(false);
  const seriesLastWatchRef = useRef<Record<string, any>>(loadSeriesLastWatchMap());
  const seriesPickerSourceChannelRef = useRef<any | null>(null);
  const seriesPickerEpisodesRef = useRef<any[]>([]);
  seriesPickerEpisodesRef.current = seriesPickerEpisodes;
  const lastPlayRequestRef = useRef<{ id: string | null; url: string | null; at: number }>({
    id: null,
    url: null,
    at: 0
  });
  const playChannelRef = useRef<(ch: any, options?: { forceRestart?: boolean; skipResumePrompt?: boolean; resumeAt?: number; skipMovieDetails?: boolean }) => void>(() => {});
  const scheduleLiveReconnectRef = useRef<(reason: string) => void>(() => {});
  const liveReconnectTimerRef = useRef<number | null>(null);
  const liveReconnectAttemptRef = useRef(0);
  const hadLivePlayingRef = useRef(false);
  const lastFavoriteToggleAtRef = useRef(0);
  const lastBackHandledAtRef = useRef(0);
  const [posterRestoreId, setPosterRestoreId] = useState<string | null>(null);
  const [seriesPickerFocusEpisodeId, setSeriesPickerFocusEpisodeId] = useState<string | null>(null);
  const [isMovieDetailsVisible, setIsMovieDetailsVisible] = useState(false);
  const [movieDetailsChannel, setMovieDetailsChannel] = useState<any | null>(null);
  const [movieDetailsInfo, setMovieDetailsInfo] = useState<XtreamVodInfo | null>(null);
  const [movieDetailsLoading, setMovieDetailsLoading] = useState(false);
  const movieDetailsTokenRef = useRef(0);
  const [vodResumePrompt, setVodResumePrompt] = useState<{
    channel: any;
    position: number;
    duration: number;
  } | null>(null);
  const vodSeekTokenRef = useRef(0);
  const vodSeekPendingRef = useRef(false);
  const seriesAutoAdvanceTokenRef = useRef(0);
  const lastSeriesEndedRef = useRef<{ url: string | null; at: number }>({
    url: null,
    at: 0
  });
  const guidePrefetchInFlightRef = useRef(false);
  const guidePrefetchedIdsRef = useRef<Set<string>>(new Set());
  const guidePrefetchCursorRef = useRef(0);
  const startupAutoLoadInFlightRef = useRef(false);
  const startupCacheHydrationCompletedRef = useRef(false);
  const setupSecurity = readSetupSecurity();
  const isLoginOverlayVisible = setupSecurity.loginRequired && accessLevel === null;
  const shouldShowOpeningMenu = showOpeningScreen;

  useEffect(() => {
    if (!document.body) return;
    // Keep Back behavior in-app so the user returns to the main menu before
    // leaving the app. webOS native exit should not preempt menu navigation.
    document.body.dataset.nativeBackExit = "blocked";
  }, [shouldShowOpeningMenu, activePanel]);

  useEffect(() => {
    if (
      activePanel === "recordings" ||
      activePanel === "recordingPlayback" ||
      activePanel === "recordingStorage"
    ) {
      loadRecordings();
    }
  }, [activePanel]);

  useEffect(() => {
    activePlaylistIdRef.current = activePlaylistId;
  }, [activePlaylistId]);

  useEffect(() => {
    const refreshPlaylistsPresence = () => {
      const loaded = loadPlaylists();
      setHasPlaylists(loaded.length > 0);
      setPlaylistsRevision((revision) => revision + 1);
      if (!activePlaylistIdRef.current) {
        const preferred = resolveStoredPlaylistId(loaded);
        if (preferred) {
          setActivePlaylistId(preferred);
          writeStoredItem(SHARED_PLAYLIST_ID_KEY, preferred);
        }
      }
    };

    if (isCapacitorRuntime()) {
      const deferRefresh = () => window.setTimeout(refreshPlaylistsPresence, 400);
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(deferRefresh, { timeout: 2500 });
      } else {
        deferRefresh();
      }
    } else {
      refreshPlaylistsPresence();
    }

    window.addEventListener("playlistsChanged", refreshPlaylistsPresence);
    window.addEventListener("playlistsHydrationComplete", refreshPlaylistsPresence);
    return () => {
      window.removeEventListener("playlistsChanged", refreshPlaylistsPresence);
      window.removeEventListener("playlistsHydrationComplete", refreshPlaylistsPresence);
    };
  }, []);

  useEffect(() => {
    const handleFavoritesChanged = () => {
      setFavoritesRefreshTick((tick) => tick + 1);
    };

    window.addEventListener("favoritesChanged", handleFavoritesChanged);
    return () => {
      window.removeEventListener("favoritesChanged", handleFavoritesChanged);
    };
  }, []);

  useEffect(() => {
    const handleLastWatchedChanged = () => {
      setLastWatchedRefreshTick((tick) => tick + 1);
    };

    window.addEventListener("lastWatchedChanged", handleLastWatchedChanged);
    return () => {
      window.removeEventListener("lastWatchedChanged", handleLastWatchedChanged);
    };
  }, []);

  useEffect(() => {
    const handleChannelsWrite = (event: Event) => {
      const trace = (event as CustomEvent<{ applied?: boolean }>).detail;
      if (trace?.applied) {
        setChannelUpdateTick((tick) => tick + 1);
      }
    };

    window.addEventListener("channelsWriteTrace", handleChannelsWrite);
    return () => {
      window.removeEventListener("channelsWriteTrace", handleChannelsWrite);
    };
  }, []);

  useEffect(() => {
    accessLevelRef.current = accessLevel;
    // Any role/login change invalidates pending generic auto-load requests.
    autoLoadTokenRef.current += 1;
  }, [accessLevel]);

  useEffect(() => {
    try {
      if (moviesSortDirection) {
        localStorage.setItem(MOVIES_SORT_DIRECTION_KEY, moviesSortDirection);
      } else {
        localStorage.removeItem(MOVIES_SORT_DIRECTION_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [moviesSortDirection]);

  useEffect(() => {
    try {
      if (groupSortDirection) {
        localStorage.setItem(GROUP_SORT_DIRECTION_KEY, groupSortDirection);
      } else {
        localStorage.removeItem(GROUP_SORT_DIRECTION_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [groupSortDirection]);

  useEffect(() => {
    try {
      if (seriesSortDirection) {
        localStorage.setItem(SERIES_SORT_DIRECTION_KEY, seriesSortDirection);
      } else {
        localStorage.removeItem(SERIES_SORT_DIRECTION_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [seriesSortDirection]);

  const masterMinListVersion = useSyncExternalStore(
    subscribeMasterMinList,
    getMasterMinListVersion,
    getMasterMinListVersion
  );
  const applyMasterMinList = accessLevel === "master" && hasMasterMinList();

  useEffect(() => {
    setSelectedMasterKey(null);
  }, [contentMode]);

  useEffect(() => {
    if (accessLevel === "adult" || accessLevel === "child") {
      setRoleChannelWriteLock(accessLevel);
      return;
    }

    setRoleChannelWriteLock(null);
  }, [accessLevel]);

  useEffect(() => {
    if (!isCapacitorRuntime()) return;
    const isLiveGroupContext =
      contentPage === "live" || (contentPage === "playlistManager" && contentMode === "tv");
    if (!isLiveGroupContext) return;
    if (!activeGroup) return;
    if (!showLiveMenu && hasSelectedLiveChannel) return;

    let cancelled = false;
    void (async () => {
      if (activeGroup === ROOT_GROUP) {
        await loadCapacitorFavoriteChannels();
      } else if (activeGroup !== LAST_WATCHED_GROUP) {
        await loadCapacitorLiveGroupChannels(activeGroup);
      }
      if (!cancelled) {
        setChannelUpdateTick((tick) => tick + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeGroup, contentPage, contentMode, showLiveMenu, hasSelectedLiveChannel]);

  useEffect(() => {
    if (!isCapacitorRuntime()) return;
    if (contentMode !== "movies" && contentMode !== "series") return;
    const onMoviesOrSeriesScreen =
      contentPage === contentMode ||
      (contentPage === "playlistManager" && (contentMode === "movies" || contentMode === "series"));
    if (!onMoviesOrSeriesScreen) return;
    if (!activeGroup || activeGroup === LAST_WATCHED_GROUP) return;

    let cancelled = false;
    void (async () => {
      if (activeGroup === ROOT_GROUP) {
        await loadCapacitorVodFavoriteChannels(contentMode);
      } else {
        await loadCapacitorVodGroupChannels(contentMode, activeGroup);
      }
      if (!cancelled) {
        setChannelUpdateTick((tick) => tick + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeGroup, contentPage, contentMode, favoritesRefreshTick]);

  const allChannels = useMemo(() => {
    return getAllChannels().filter((channel) => isChannelRecord(channel));
  }, [channelUpdateTick, currentChannel]);
  const hasPlayableChannels = useMemo(
    () => allChannels.some((ch) => typeof ch?.url === "string" && ch.url.trim().length > 0),
    [allChannels]
  );
  const channelsByMode = useMemo(() => {
    const buckets: Record<"tv" | "movies" | "series", any[]> = {
      tv: [],
      movies: [],
      series: []
    };

    for (const channel of allChannels) {
      if (matchesContentMode(channel, "tv")) buckets.tv.push(channel);
      if (matchesContentMode(channel, "movies")) buckets.movies.push(channel);
      if (matchesContentMode(channel, "series")) buckets.series.push(channel);
    }

    return buckets;
  }, [allChannels]);

  const contentChannels = useMemo(() => {
    return channelsByMode[contentMode];
  }, [channelsByMode, contentMode]);
  const groups = useMemo(() => {
    if (isCapacitorRuntime() && contentMode === "tv") {
      // During native playback, avoid building a 2k+ group sidebar from catalog metadata.
      if (currentChannel && matchesContentMode(currentChannel, "tv")) {
        const groupSet = new Set<string>([ROOT_GROUP, LAST_WATCHED_GROUP]);
        contentChannels.forEach((channel) => {
          const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
          groupSet.add(groupName);
        });
        return Array.from(groupSet);
      }

      const capacitorGroups = getCapacitorLiveGroupNames();
      if (capacitorGroups.length > 0) {
        return [ROOT_GROUP, LAST_WATCHED_GROUP, ...capacitorGroups.filter((group) => group !== LAST_WATCHED_GROUP)];
      }
    }

    if (isCapacitorRuntime() && (contentMode === "movies" || contentMode === "series")) {
      const vodGroups = getCapacitorVodGroupNames(contentMode);
      if (vodGroups.length > 0) {
        return [ROOT_GROUP, LAST_WATCHED_GROUP, ...vodGroups.filter((group) => group !== LAST_WATCHED_GROUP)];
      }
    }

    const groupSet = new Set<string>([ROOT_GROUP, LAST_WATCHED_GROUP]);
    contentChannels.forEach((channel) => {
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      if (groupName !== LAST_WATCHED_GROUP) groupSet.add(groupName);
    });
    return Array.from(groupSet);
  }, [contentChannels, contentMode, channelUpdateTick, currentChannel]);
  const visibleGroups = useMemo(() => {
    return groups.filter((group) => {
      if (!isGroupVisible(group, contentMode)) return false;
      if (applyMasterMinList && contentMode === "tv") {
        return groupMatchesMasterMinList(group);
      }
      return true;
    });
  }, [groups, categoryRefreshTick, applyMasterMinList, contentMode, masterMinListVersion]);
  const visibleChannelsByMode = useMemo(() => {
    const visibleBuckets: Record<"tv" | "movies" | "series", any[]> = {
      tv: [],
      movies: [],
      series: []
    };

    for (const mode of ["tv", "movies", "series"] as const) {
      visibleBuckets[mode] = channelsByMode[mode].filter((channel) => {
        if (!isChannelRecord(channel)) return false;
        const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
        return (
          isGroupVisible(groupName, mode) &&
          isChannelVisible(String(channel.id || "")) &&
          (!applyMasterMinList || mode !== "tv" || groupMatchesMasterMinList(groupName))
        );
      });
    }

    return visibleBuckets;
  }, [channelsByMode, categoryRefreshTick, applyMasterMinList, masterMinListVersion]);
  const visibleChannels = useMemo(() => {
    return visibleChannelsByMode[contentMode];
  }, [visibleChannelsByMode, contentMode]);
  const visibleTvChannels = visibleChannelsByMode.tv;
  const visibleTvGuideChannels = visibleTvChannels;
  const groupsForList = useMemo(() => {
    const useVisibleOnly =
      isLiveContentPage || isMainMoviesScreen || (isSeriesPage && !isPlaylistManagerPage);
    const source = useVisibleOnly ? visibleGroups : groups;
    if (isPlaylistManagerPage && selectedMasterKey) {
      return source.filter((group) => {
        if (group === ROOT_GROUP || group === LAST_WATCHED_GROUP) return true;
        return extractMasterBouquetKey(group) === selectedMasterKey;
      });
    }
    return source;
  }, [
    isLiveContentPage,
    isMainMoviesScreen,
    isSeriesPage,
    isPlaylistManagerPage,
    visibleGroups,
    groups,
    selectedMasterKey
  ]);
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { [ROOT_GROUP]: 0, [LAST_WATCHED_GROUP]: 0 };
    counts[LAST_WATCHED_GROUP] = resolveLastWatchedChannels(
      contentMode === "tv" ? "tv" : contentMode,
      contentChannels
    ).length;

    if (isCapacitorRuntime() && contentMode === "tv") {
      if (!(currentChannel && matchesContentMode(currentChannel, "tv"))) {
        const capacitorCounts = getCapacitorLiveGroupCounts();
        Object.entries(capacitorCounts).forEach(([groupName, count]) => {
          counts[groupName] = count;
        });
        for (const channel of contentChannels) {
          if (!isChannelRecord(channel)) continue;
          if (isFavoriteChannelRecord(channel)) counts[ROOT_GROUP] += 1;
        }
        return counts;
      }
    }

    if (isCapacitorRuntime() && (contentMode === "movies" || contentMode === "series")) {
      const vodCounts = getCapacitorVodGroupCounts(contentMode);
      if (Object.keys(vodCounts).length > 0) {
        Object.entries(vodCounts).forEach(([groupName, count]) => {
          counts[groupName] = count;
        });
        counts[ROOT_GROUP] = countCapacitorFavoriteRecords(contentMode);
        return counts;
      }
    }

    for (const channel of contentChannels) {
      if (!isChannelRecord(channel)) continue;
      if (isFavoriteChannelRecord(channel)) counts[ROOT_GROUP] += 1;

      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      counts[groupName] = (counts[groupName] || 0) + 1;
    }

    return counts;
  }, [contentChannels, contentMode, favoritesRefreshTick, lastWatchedRefreshTick, channelUpdateTick, currentChannel]);
  const channelsForScope = useMemo(() => {
    return isLiveContentPage ? visibleChannels : contentChannels;
  }, [isLiveContentPage, visibleChannels, contentChannels]);
  const filteredChannels = useMemo(() => {
    if (activeGroup === LAST_WATCHED_GROUP) {
      return resolveLastWatchedChannels(contentMode === "tv" ? "tv" : contentMode, contentChannels);
    }
    if (activeGroup === ROOT_GROUP) {
      // Favorites should show all starred channels for the current content mode,
      // even when their original groups/channels are hidden.
      return contentChannels.filter((channel) => {
        if (!isChannelRecord(channel)) return false;
        return isFavoriteChannelRecord(channel);
      });
    }
    return channelsForScope.filter((channel) => {
      if (!isChannelRecord(channel)) return false;
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      return groupName === activeGroup;
    });
  }, [channelsForScope, contentChannels, contentMode, activeGroup, categoryRefreshTick, favoritesRefreshTick, lastWatchedRefreshTick]);
  const searchableSeriesChannels = useMemo(() => {
    if (!isSeriesPage) return [] as any[];
    return contentChannels.filter((channel) => isUnhiddenContentChannel(channel));
  }, [isSeriesPage, contentChannels, categoryRefreshTick]);
  const searchableSeriesIndex = useMemo(() => {
    return searchableSeriesChannels.map((channel, index) => {
      const name = String(channel?.name || "").toLowerCase();
      const group = String(channel?.group || "").toLowerCase();
      return {
        key: `${String(channel?.id || "series")}:${index}`,
        channel,
        haystack: `${name.slice(0, 180)} ${group.slice(0, 100)}`.trim()
      };
    });
  }, [searchableSeriesChannels]);
  const filteredChannelsForDisplay = useMemo(() => {
    if (isMainMoviesScreen) {
      const term = String(moviesMainSearchTerm || "").trim().toLowerCase();
      const movies = contentChannels.filter((channel) => isChannelRecord(channel));
      const visibleMovies = movies.filter((channel) => isUnhiddenContentChannel(channel));

      if (term) {
        const searched = moviesMainSearchResults ?? [];
        return searched.filter((channel) => isUnhiddenContentChannel(channel));
      }

      const scopedMovies =
        activeGroup === ROOT_GROUP
          ? movies.filter((channel) => isFavoriteChannelRecord(channel))
          : activeGroup === LAST_WATCHED_GROUP
            ? resolveLastWatchedChannels("movies", movies)
            : visibleMovies.filter((channel) => {
              const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
              return groupName === activeGroup;
            });

      if (activeGroup === LAST_WATCHED_GROUP) return scopedMovies;
      return sortChannelsByName(scopedMovies, moviesSortDirection);
    }

    if (!isSeriesPage) return filteredChannels;

    const term = String(seriesMainSearchDebouncedTerm || "").trim().toLowerCase();
    if (term) {
      if (term.length < SERIES_SEARCH_MIN_TERM_LENGTH) return [];
      return (seriesMainSearchResults ?? []).filter((channel) => isUnhiddenContentChannel(channel));
    }

    if (activeGroup === LAST_WATCHED_GROUP) {
      return filteredChannels;
    }
    if (activeGroup === ROOT_GROUP) {
      return sortChannelsByName(filteredChannels, seriesSortDirection);
    }

    // The playlist manager must keep hidden groups' channels listed so their
    // visibility can be toggled back on; the public series view hides them.
    const visibleSeriesChannels = isPlaylistManagerPage
      ? filteredChannels.filter((channel) => isChannelRecord(channel))
      : filteredChannels.filter((channel) => isUnhiddenContentChannel(channel));
    return sortChannelsByName(visibleSeriesChannels, seriesSortDirection);
  }, [
    isMainMoviesScreen,
    moviesMainSearchTerm,
    moviesMainSearchResults,
    contentChannels,
    activeGroup,
    categoryRefreshTick,
    isSeriesPage,
    isPlaylistManagerPage,
    filteredChannels,
    seriesMainSearchDebouncedTerm,
    seriesMainSearchResults,
    moviesSortDirection,
    seriesSortDirection,
    favoritesRefreshTick,
    lastWatchedRefreshTick
  ]);
  const showIdlePlayerStatus = !showOpeningScreen && !currentChannel && activePanel === null && filteredChannels.length === 0;

  function commitSeriesMainSearch(nextTerm: string) {
    setSeriesMainSearchDebouncedTerm(nextTerm);
  }

  function openSeriesSearchComposer() {
    seriesDraftRef.current = seriesMainSearchDebouncedTerm;
    setSeriesMainSearchDraft(seriesMainSearchDebouncedTerm);
    resetComposerTextEditGuard();
    composerOpenedAtRef.current = Date.now();
    setIsSeriesSearchComposerOpen(true);
  }

  function openMoviesSearchComposer() {
    moviesDraftRef.current = moviesMainSearchTerm;
    setMoviesMainSearchDraft(moviesMainSearchTerm);
    resetComposerTextEditGuard();
    composerOpenedAtRef.current = Date.now();
    setIsMoviesSearchComposerOpen(true);
  }

  function clearCatalogSearch() {
    setMoviesMainSearchTerm("");
    setMoviesMainSearchDraft("");
    moviesDraftRef.current = "";
    setMoviesMainSearchResults(null);
    setMoviesSearchBusy(false);
    setSeriesMainSearchDraft("");
    seriesDraftRef.current = "";
    setSeriesMainSearchDebouncedTerm("");
    setSeriesMainSearchResults(null);
    setIsSeriesSearchComposerOpen(false);
    setIsMoviesSearchComposerOpen(false);
  }

  function selectBrowseGroup(group: string) {
    clearCatalogSearch();
    setActiveGroup(group);
  }

  function appendSeriesSearchDraft(fragment: string) {
    if (!beginComposerTextEdit(`series:+${fragment}`)) return;
    const next = `${seriesDraftRef.current}${fragment}`.slice(0, 32);
    seriesDraftRef.current = next;
    setSeriesMainSearchDraft(next);
    commitSeriesMainSearch(next);
  }

  function backspaceSeriesSearchDraft() {
    if (!beginComposerTextEdit("series:-")) return;
    const next = seriesDraftRef.current.slice(0, -1);
    seriesDraftRef.current = next;
    setSeriesMainSearchDraft(next);
    commitSeriesMainSearch(next);
  }

  function applySeriesSearchDraft() {
    commitSeriesMainSearch(seriesMainSearchDraft);
    setIsSeriesSearchComposerOpen(false);
  }

  function appendMoviesSearchDraft(fragment: string) {
    if (!beginComposerTextEdit(`movies:+${fragment}`)) return;
    const next = `${moviesDraftRef.current}${fragment}`.slice(0, 64);
    moviesDraftRef.current = next;
    setMoviesMainSearchDraft(next);
  }

  function backspaceMoviesSearchDraft() {
    if (!beginComposerTextEdit("movies:-")) return;
    const next = moviesDraftRef.current.slice(0, -1);
    moviesDraftRef.current = next;
    setMoviesMainSearchDraft(next);
  }

  function applyMoviesSearchDraft() {
    setMoviesMainSearchTerm(moviesMainSearchDraft);
    setIsMoviesSearchComposerOpen(false);
  }

  function captureVodProgress(channel: any = currentChannelRef.current) {
    if (vodSeekPendingRef.current) return;
    if (!channel) return;
    const isVod =
      matchesContentMode(channel, "movies") || matchesContentMode(channel, "series");
    if (!isVod) return;
    const snapshot = readVideoPlaybackPosition(
      document.getElementById("player-main") as HTMLVideoElement | null
    );
    if (!snapshot) return;
    saveVodResume(channel, snapshot.position, snapshot.duration);
  }

  function applyVodResumeSeek(seconds: number) {
    const token = ++vodSeekTokenRef.current;
    vodSeekPendingRef.current = true;
    const finish = () => {
      if (token === vodSeekTokenRef.current) vodSeekPendingRef.current = false;
    };
    const trySeek = (attempt: number) => {
      if (token !== vodSeekTokenRef.current) return;
      const player = document.getElementById("player-main") as HTMLVideoElement | null;
      if (!player) {
        if (attempt < 40) window.setTimeout(() => trySeek(attempt + 1), 250);
        else finish();
        return;
      }

      let target = seconds;
      if (player.seekable && player.seekable.length > 0) {
        const end = player.seekable.end(player.seekable.length - 1);
        if (Number.isFinite(end) && end > 1) {
          target = Math.min(seconds, Math.max(0, end - 0.5));
        }
      } else if (Number.isFinite(player.duration) && player.duration > 1) {
        target = Math.min(seconds, Math.max(0, player.duration - 1));
      } else if (attempt < 40) {
        window.setTimeout(() => trySeek(attempt + 1), 250);
        return;
      } else {
        finish();
        return;
      }

      try {
        player.currentTime = Math.max(0, target);
        window.setTimeout(finish, 1500);
      } catch {
        if (attempt < 40) window.setTimeout(() => trySeek(attempt + 1), 250);
        else finish();
      }
    };

    window.setTimeout(() => trySeek(0), 400);
  }

  function exitVodPlayback() {
    setAudioLanguagePickerOpen(false);
    window.dispatchEvent(new Event("closeAudioLanguagePicker"));
    captureVodProgress();
    const playing = currentChannelRef.current;
    const playingSeriesEpisode =
      !!playing &&
      String(playing.contentType || "").toLowerCase() === "series" &&
      !isTopLevelSeriesSelection(playing);
    const returnToSeriesPicker = playingSeriesEpisode && !!seriesPickerSourceChannel;
    const returnToMovieDetails =
      !!playing && matchesContentMode(playing, "movies") && !!movieDetailsChannel;

    stopPlayback();
    setCurrentChannel(null);
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setShowNowNext(false);
    setActivePanel(null);
    if (returnToSeriesPicker) {
      setSeriesPickerFocusEpisodeId(String(playing?.id || "") || null);
      if (seriesDetailsChannel || seriesPickerSourceChannel) {
        setIsSeriesDetailsVisible(true);
      }
      setIsSeriesPickerVisible(false);
    } else if (returnToMovieDetails) {
      setIsMovieDetailsVisible(true);
    }
  }

  function stopCurrentVodPlaybackIfNeeded() {
    const activeChannel = currentChannelRef.current;
    if (!activeChannel) return;

    const isVodChannel =
      matchesContentMode(activeChannel, "movies") || matchesContentMode(activeChannel, "series");
    if (!isVodChannel) return;

    exitVodPlayback();
  }

  function exitLivePlaybackToBrowser() {
    suppressPlayerEventsRef.current = true;
    stopPlayback();

    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (player) {
      try {
        player.pause();
        player.currentTime = 0;
        player.removeAttribute("src");
        player.load();
      } catch {
        // Ignore hard-reset errors.
      }
    }

    setCurrentChannel(null);
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setShowNowNext(false);
    setActivePanel(null);
    setShowLiveMenu(true);
    setHasSelectedLiveChannel(false);
    setIsLiveFullscreenRequested(false);
    setShowOpeningScreen(false);

    window.setTimeout(() => {
      suppressPlayerEventsRef.current = false;
    }, 3000);
  }

  function exitAnyFullscreen() {
    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };

    if (!document.fullscreenElement && !doc.webkitFullscreenElement) return;

    if (document.exitFullscreen) {
      void document.exitFullscreen().catch(() => {});
      return;
    }

    if (doc.webkitExitFullscreen) {
      void doc.webkitExitFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    if (!groupsForList.includes(activeGroup)) {
      setActiveGroup(groupsForList[0] || ROOT_GROUP);
    }
  }, [groupsForList, activeGroup]);

  useEffect(() => {
    setPosterRestoreId(null);
  }, [activeGroup]);

  useEffect(() => {
    if (isLiveContentPage && !isGroupVisible(activeGroup, "tv") && activeGroup !== ROOT_GROUP) {
      setActiveGroup(ROOT_GROUP);
    }
  }, [isLiveContentPage, activeGroup, categoryRefreshTick]);

  useEffect(() => {
    const inSeriesContext = isSeriesPage || isPlaylistManagerSeriesMode;
    if (!inSeriesContext && isSeriesPickerVisible) {
      setIsSeriesPickerVisible(false);
      setSeriesPickerLoading(false);
      setSeriesPickerError(null);
      setSeriesPickerEpisodes([]);
      setSeriesPickerTitle("");
    }
    if (!inSeriesContext && isSeriesDetailsVisible) {
      setIsSeriesDetailsVisible(false);
      setSeriesDetailsLoading(false);
    }
  }, [isSeriesPage, isPlaylistManagerSeriesMode, isSeriesPickerVisible, isSeriesDetailsVisible]);

  useEffect(() => {
    const stayingOnMovieBrowse =
      isMoviesPage || (isPlaylistManagerPage && contentMode === "movies");
    if (!stayingOnMovieBrowse && isMovieDetailsVisible) {
      setIsMovieDetailsVisible(false);
      setMovieDetailsLoading(false);
    }
  }, [isMoviesPage, isPlaylistManagerPage, contentMode, isMovieDetailsVisible]);

  useEffect(() => {
    if (isSeriesPage) return;
    setIsSeriesSearchComposerOpen(false);
    setSeriesMainSearchDraft("");
    setSeriesMainSearchDebouncedTerm("");
  }, [isSeriesPage]);

  useEffect(() => {
    if (isSeriesPickerVisible || isSeriesDetailsVisible) {
      setIsSeriesSearchComposerOpen(false);
    }
  }, [isSeriesPickerVisible, isSeriesDetailsVisible]);

  useEffect(() => {
    if (isMainMoviesScreen) return;
    setMoviesMainSearchTerm("");
    setMoviesMainSearchDraft("");
    setMoviesMainSearchResults(null);
    setMoviesSearchBusy(false);
    setIsMoviesSearchComposerOpen(false);
  }, [isMainMoviesScreen]);

  useEffect(() => {
    if (!isMainMoviesScreen) {
      setMoviesMainSearchResults(null);
      setMoviesSearchBusy(false);
      return;
    }

    const term = String(moviesMainSearchTerm || "").trim().toLowerCase();
    if (!term) {
      setMoviesMainSearchResults(null);
      setMoviesSearchBusy(false);
      return;
    }

    let cancelled = false;
    setMoviesSearchBusy(true);
    setMoviesMainSearchResults(
      rankCatalogSearchMatches(
        contentChannels.filter((channel) => isChannelRecord(channel)),
        term,
        moviesSortDirection
      )
    );

    void (async () => {
      const pool = isCapacitorRuntime()
        ? await searchCapacitorVodCatalog("movies", term)
        : contentChannels.filter((channel) => isChannelRecord(channel));
      if (cancelled) return;
      setMoviesMainSearchResults(rankCatalogSearchMatches(pool, term, moviesSortDirection));
      setMoviesSearchBusy(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [isMainMoviesScreen, moviesMainSearchTerm]);

  useEffect(() => {
    const term = String(moviesMainSearchTerm || "").trim().toLowerCase();
    if (!term) return;
    setMoviesMainSearchResults((current) =>
      current ? rankCatalogSearchMatches(current, term, moviesSortDirection) : current
    );
  }, [moviesSortDirection]);

  useEffect(() => {
    if (!isSeriesPage) {
      setSeriesMainSearchResults(null);
      return;
    }

    const term = String(seriesMainSearchDebouncedTerm || "").trim().toLowerCase();
    if (!term) {
      setSeriesMainSearchResults(null);
      return;
    }
    if (term.length < SERIES_SEARCH_MIN_TERM_LENGTH) {
      setSeriesMainSearchResults([]);
      return;
    }

    let cancelled = false;
    setSeriesMainSearchResults(
      rankCatalogSearchMatches(
        searchableSeriesIndex.map((entry) => entry.channel),
        term,
        seriesSortDirection
      )
    );
    void (async () => {
      const pool = isCapacitorRuntime()
        ? await searchCapacitorVodCatalog("series", term)
        : searchableSeriesIndex.map((entry) => entry.channel);
      if (cancelled) return;
      setSeriesMainSearchResults(rankCatalogSearchMatches(pool, term, seriesSortDirection));
    })();

    return () => {
      cancelled = true;
    };
  }, [isSeriesPage, seriesMainSearchDebouncedTerm, searchableSeriesIndex.length, seriesSortDirection]);

  useEffect(() => {
    initPlayerEngine();
    initNavigation((panel) => {
      if (!canOpenPanelWithSecurity(panel)) {
        return;
      }

      if (panel === "vod") {
        stopCurrentVodPlaybackIfNeeded();
        setContentPage("movies");
        setContentMode("movies");
        setShowOpeningScreen(false);
        setActivePanel(null);
        setActiveGroup(pickDefaultContentGroup(getAllChannels(), "movies"));
        return;
      }

      if (panel === "series") {
        stopCurrentVodPlaybackIfNeeded();
        setContentPage("series");
        setContentMode("series");
        setShowOpeningScreen(false);
        setActivePanel(null);
        setActiveGroup(pickDefaultContentGroup(getAllChannels(), "series"));
        return;
      }

      if (panel === "playlistManager") {
        setContentPage("playlistManager");
        setShowOpeningScreen(false);
        setActivePanel(null);
        return;
      }

      if (panel === "epgSearch" || panel === "timeline") {
        void openGuidePanel(panel);
        return;
      }

      setActivePanel(panel);
    });
  }, []);

  function readSetupSecurity() {
    try {
      const loginRequired = localStorage.getItem("iptvmate_setup_login_required") === "1";
      const masterCode = (localStorage.getItem("iptvmate_setup_master_code") || "").trim().toUpperCase();
      const adultCode = (localStorage.getItem("iptvmate_setup_adult_code") || "").trim().toUpperCase();
      const childCode = (localStorage.getItem("iptvmate_setup_child_code") || "").trim().toUpperCase();

      const hasValidCode = [masterCode, adultCode, childCode].some((value) => /^[A-Z0-9]{4}$/.test(value));
      // Guard against setup deadlock: do not enforce login if no valid code exists.
      const effectiveLoginRequired = loginRequired && hasValidCode;

      return {
        loginRequired: effectiveLoginRequired,
        masterCode,
        adultCode,
        childCode
      };
    } catch {
      return { loginRequired: false, masterCode: "", adultCode: "", childCode: "" };
    }
  }

  function pickDefaultContentGroup(
    channels: any[],
    content: "tv" | "movies" | "series"
  ): string {
    for (const channel of channels) {
      if (!isChannelRecord(channel) || !matchesContentMode(channel, content)) continue;
      if (isFavoriteChannelRecord(channel)) {
        return ROOT_GROUP;
      }
    }

    for (const channel of channels) {
      if (!isChannelRecord(channel) || !matchesContentMode(channel, content)) continue;

      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      if (groupName !== ROOT_GROUP) {
        return groupName;
      }
    }

    return ROOT_GROUP;
  }

  function pickDefaultLiveGroup(channels: any[]): string {
    return pickDefaultContentGroup(channels, "tv");
  }

  function readRoleCache(kind: "adult" | "child", assignedPlaylistId: string) {
    try {
      const key = kind === "adult" ? ADULT_ROLE_CACHE_KEY : CHILD_ROLE_CACHE_KEY;
      const raw = readStoredItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        playlistId?: unknown;
        channels?: unknown[];
        visibility?: unknown;
      };

      if (!parsed || (!Array.isArray(parsed.channels) && !parsed.visibility)) return null;
      const cachePlaylistId = String(parsed.playlistId || "").trim();
      if (!cachePlaylistId && !parsed.visibility) {
        return null;
      }

      const channels = Array.isArray(parsed.channels)
        ? parsed.channels.filter((item) => isChannelRecord(item))
        : [];

      if (isCapacitorRuntime()) {
        if (!cachePlaylistId && channels.length === 0 && !parsed.visibility) return null;
        return {
          playlistId: cachePlaylistId || assignedPlaylistId,
          channels,
          visibility: parsed.visibility as ChannelVisibilitySnapshot | undefined
        };
      }

      if (channels.length === 0) return null;

      return {
        playlistId: cachePlaylistId || assignedPlaylistId,
        channels,
        visibility: parsed.visibility
      };
    } catch {
      return null;
    }
  }

  async function restoreRoleContentForLogin(kind: "adult" | "child"): Promise<boolean> {
    const canApply = () => {
      return accessLevel === kind;
    };

    const prepareRoleContentSwitch = () => {
      if (!canApply()) return;
      stopPlayback();
      setCurrentChannel(null);
      setPlayerError(null);
      setPlayerStatus(null);
      setPlayerWarning(null);
      setShowNowNext(false);
      setActivePanel(null);
      setHasSelectedLiveChannel(false);
      setIsLiveFullscreenRequested(false);
      setShowOpeningScreen(false);
    };

    const clearInheritedRoleContent = () => {
      if (!canApply()) return;
      prepareRoleContentSwitch();
      setChannels([], "role-clear");
      setChannelUpdateTick((t) => t + 1);
      resetVisibilityForCurrentChannels();
      setCategoryRefreshTick((tick) => tick + 1);
    };

    const rolePlaylistId = readStoredItem(
      kind === "adult" ? ADULT_PLAYLIST_ID_KEY : CHILD_PLAYLIST_ID_KEY
    );
    const sharedPlaylistId = (
      rolePlaylistId ||
      activePlaylistId ||
      readStoredItem(SHARED_PLAYLIST_ID_KEY) ||
      loadPlaylists()[0]?.id ||
      ""
    ).trim();

    if (!sharedPlaylistId) {
      clearInheritedRoleContent();
      return false;
    }

    const fromCache = readRoleCache(kind, sharedPlaylistId);
    const sharedPlaylist = loadPlaylists().find((playlist) => String(playlist.id) === sharedPlaylistId);
    if (!sharedPlaylist) {
      clearInheritedRoleContent();
      return false;
    }

    try {
      const existingChannels = getAllChannels();
      let channels =
        fromCache?.channels && fromCache.channels.length > 0
          ? fromCache.channels
          : existingChannels;

      if (isCapacitorRuntime()) {
        const catalogGroups = getCapacitorLiveGroupNames();
        if (catalogGroups.length > 0) {
          if (!canApply()) return false;
          prepareRoleContentSwitch();
          if (fromCache?.visibility) {
            applyVisibilitySnapshotForCurrentChannels(fromCache.visibility);
          }
          setActivePlaylistId(sharedPlaylist.id);
          writeStoredItem(SHARED_PLAYLIST_ID_KEY, sharedPlaylist.id);
          writeStoredItem(
            kind === "adult" ? ADULT_PLAYLIST_ID_KEY : CHILD_PLAYLIST_ID_KEY,
            sharedPlaylist.id
          );
          const targetGroup = catalogGroups[0];
          await loadCapacitorLiveGroupChannels(targetGroup);
          setChannelUpdateTick((t) => t + 1);
          setActiveGroup(targetGroup);
          setTimeout(() => setActiveVisibilityRole(kind), 0);
          return true;
        }

        // No local catalog yet — Playlist Manager Load is the only provider fetch.
        return false;
      }

      if (!Array.isArray(channels) || channels.length === 0) {
        clearInheritedRoleContent();
        return false;
      }
      if (!canApply()) {
        return false;
      }

      prepareRoleContentSwitch();
      setChannels(channels, "role-restore");
      setChannelUpdateTick((t) => t + 1);
      setActivePlaylistId(sharedPlaylist.id);
      writeStoredItem(SHARED_PLAYLIST_ID_KEY, sharedPlaylist.id);
      writeStoredItem(
        kind === "adult" ? ADULT_PLAYLIST_ID_KEY : CHILD_PLAYLIST_ID_KEY,
        sharedPlaylist.id
      );
      setActiveGroup(pickDefaultLiveGroup(channels));
      
      // Defer visibility role application to after initial render (avoids blocking on large playlists)
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(() => setActiveVisibilityRole(kind));
      } else {
        setTimeout(() => setActiveVisibilityRole(kind), 0);
      }
      
      void loadEPGForPlaylist(sharedPlaylist).catch(() => {
        // EPG is optional during login-role restore.
      });
      return true;
    } catch {
      clearInheritedRoleContent();
      return false;
    }
  }

  async function submitLoginCode() {
    const { masterCode, adultCode, childCode } = readSetupSecurity();
    const normalized = loginCodeInput.trim().toUpperCase();

    if (!normalized) {
      setLoginError("Enter a code to continue.");
      return;
    }

    if (masterCode && normalized === masterCode) {
      autoLoadTokenRef.current += 1;
      setAccessLevel("master");
      setLoginError(null);
      setLoginCodeInput("");
      setShowOpeningScreen(true);
      setActivePanel(null);
      return;
    }

    if (adultCode && normalized === adultCode) {
      autoLoadTokenRef.current += 1;
      setAccessLevel("adult");
      setLoginError(null);
      setLoginCodeInput("");
      setShowOpeningScreen(true);
      setActivePanel(null);
      return;
    }

    if (childCode && normalized === childCode) {
      autoLoadTokenRef.current += 1;
      setAccessLevel("child");
      setLoginError(null);
      setLoginCodeInput("");
      setShowOpeningScreen(true);
      setActivePanel(null);
      return;
    }

    setLoginError("Incorrect code.");
  }

  function canAccessContentByLevel(content: "tv" | "movies" | "series") {
    const { loginRequired } = readSetupSecurity();
    if (!loginRequired) return true;

    if (!accessLevel) {
      setLoginError("Login required.");
      return false;
    }

    if (accessLevel === "master") return true;
    if (accessLevel === "adult") return true;
    if (accessLevel === "child") return content === "movies" || content === "series" || content === "tv";
    return false;
  }

  function canOpenPanelWithSecurity(panel: string | null) {
    if (panel === null) return true;

    // TV Guide is always available regardless of login.
    if (panel === "epgSearch" || panel === "timeline") return true;

    const { loginRequired } = readSetupSecurity();
    if (!loginRequired) return true;

    if (!accessLevel) {
      setLoginError("Login required.");
      return false;
    }

    if (accessLevel === "master") return true;

    // Non-master users can only access movie/series content panels.
    if (accessLevel === "adult" && (panel === "vod" || panel === "series")) {
      return true;
    }

    if (accessLevel === "child" && (panel === "vod" || panel === "series")) {
      return true;
    }

    alert("Master Code required for this screen.");
    return false;
  }

  useEffect(() => {
    const ensureAudiblePlayback = () => {
      const player = document.getElementById("player-main") as HTMLVideoElement | null;
      if (!player) return;

      // Recover from muted autoplay fallback on first user interaction.
      if (player.muted || player.volume < 1) {
        player.muted = false;
        player.volume = 1;
        void player.play().catch(() => {
          // Ignore if playback state changes during source switches.
        });
      }
    };

    window.addEventListener("pointerdown", ensureAudiblePlayback);
    window.addEventListener("keydown", ensureAudiblePlayback);
    return () => {
      window.removeEventListener("pointerdown", ensureAudiblePlayback);
      window.removeEventListener("keydown", ensureAudiblePlayback);
    };
  }, []);

  useEffect(() => {
    // Entering Live page without an explicit selected channel should always be preview mode.
    if (!showOpeningScreen && contentPage === "live" && !currentChannel) {
      setHasSelectedLiveChannel(false);
      setShowLiveMenu(true);
    }
  }, [showOpeningScreen, contentPage, currentChannel]);

  useEffect(() => {
    if (!showOpeningScreen) return;

    // Prevent hidden/background playback from consuming resources while menu is open.
    // stopPlayback also cancels in-flight retry/transcode chains even if channel state
    // is already null.
    stopPlayback();
    document.querySelectorAll("video").forEach((element) => {
      try {
        (element as HTMLVideoElement).blur();
      } catch {
        // Ignore.
      }
    });
    if (currentChannel) {
      setCurrentChannel(null);
    }
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setShowNowNext(false);
  }, [showOpeningScreen, currentChannel]);

  useEffect(() => {
    if (contentPage !== "live") return;
    if (hasSelectedLiveChannel && currentChannel) return;
    if (!isLiveFullscreenRequested) return;
    setIsLiveFullscreenRequested(false);
  }, [contentPage, hasSelectedLiveChannel, currentChannel, isLiveFullscreenRequested]);

  useEffect(() => {
    if (!forceLivePreviewLayout) return;
    exitAnyFullscreen();
  }, [forceLivePreviewLayout]);

  useEffect(() => {
    const syncFullscreenState = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      const isFullscreen = !!document.fullscreenElement || !!doc.webkitFullscreenElement;
      setIsFullscreenActive(isFullscreen);

      if (!isFullscreen && contentPage === "live") {
        setIsLiveFullscreenRequested(false);
        setShowLiveMenu(true);
      }
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState as EventListener);
    };
  }, [contentPage]);

  useEffect(() => {
    // Global double-click handler for program/channel names to trigger fullscreen
    const handleProgramDoubleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Check if the clicked element or its parent has a program/channel name class
      const programElement = target.closest(
        ".nn-program, .epg-grid-title, .epg-event-title, .epg-search-guide-programme-title, .channel-icon-label"
      );
      
      if (!programElement) return;
      
      // Don't trigger if we're on the opening screen
      if (showOpeningScreen) return;
      
      // For live TV, use the CSS-based fullscreen so the custom control bar stays visible.
      if (contentPage === "live") {
        setIsLiveFullscreenRequested(true);
        setShowLiveMenu(false);
        return;
      }
      
      // For other content, use native browser fullscreen
      const video = document.querySelector('video');
      const targetElement = video || document.documentElement;
      
      if (targetElement.requestFullscreen) {
        void targetElement.requestFullscreen().catch(() => {});
      } else if ((targetElement as any).webkitRequestFullscreen) {
        void (targetElement as any).webkitRequestFullscreen().catch(() => {});
      }
    };

    document.addEventListener("dblclick", handleProgramDoubleClick);
    return () => {
      document.removeEventListener("dblclick", handleProgramDoubleClick);
    };
  }, [showOpeningScreen, contentPage]);

  useEffect(() => {
    if (showOpeningScreen || contentPage !== "live") return;

    const applyPinnedPreviewPosition = () => {
      const shell = document.querySelector(".live-preview-shell") as HTMLElement | null;
      const placeholder = document.querySelector(".live-preview-placeholder") as HTMLElement | null;

      if (isLivePreviewFullscreen) {
        if (shell) {
          shell.style.position = "fixed";
          shell.style.top = "0px";
          shell.style.right = "0px";
          shell.style.left = "0px";
          shell.style.bottom = "0px";
          shell.style.width = "100%";
          shell.style.height = "100%";
          shell.style.transform = "none";
        }
        if (isCapacitorRuntime()) {
          syncNativePlayerBounds(true);
        }
        return;
      }

      const tvLayout = isCapacitorRuntime();
      const margin = tvLayout ? 16 : 20;
      const compactWidth = tvLayout
        ? Math.max(280, Math.round(window.innerWidth * 0.38))
        : window.innerWidth <= 1280 ? 560 : 720;
      const compactHeight = Math.round((compactWidth * 9) / 16);
      document.documentElement.style.setProperty("--live-preview-top", `${margin}px`);
      document.documentElement.style.setProperty("--live-preview-right", `${margin}px`);

      // Keep preview dimensions deterministic so fullscreen transitions can never
      // leak viewport-sized values back into compact preview mode.
      document.documentElement.style.setProperty("--live-preview-width", `${compactWidth}px`);
      document.documentElement.style.setProperty("--live-preview-height", `${compactHeight}px`);

      [shell, placeholder].forEach((el) => {
        if (!el) return;
        el.style.position = "fixed";
        el.style.top = `${margin}px`;
        el.style.right = `${margin}px`;
        el.style.left = "auto";
        el.style.bottom = "auto";
        el.style.transform = "none";
        el.style.width = `${compactWidth}px`;
        el.style.height = `${compactHeight}px`;
      });

      if (isCapacitorRuntime()) {
        syncNativePlayerBounds(false);
      }
    };

    applyPinnedPreviewPosition();
    window.addEventListener("resize", applyPinnedPreviewPosition);

    if (isCapacitorRuntime()) {
      if (hasSelectedLiveChannel && currentChannel) {
        window.requestAnimationFrame(() => syncNativePlayerBounds(true));
      }
      return () => window.removeEventListener("resize", applyPinnedPreviewPosition);
    }

    const rafA = window.requestAnimationFrame(() => {
      const rafB = window.requestAnimationFrame(() => {
        applyPinnedPreviewPosition();
      });
      void rafB;
    });
    const intervalId = window.setInterval(applyPinnedPreviewPosition, 500);

    return () => {
      window.cancelAnimationFrame(rafA);
      window.clearInterval(intervalId);
      window.removeEventListener("resize", applyPinnedPreviewPosition);
    };
  }, [showOpeningScreen, contentPage, currentChannel?.id, isLivePreviewFullscreen]);

  useEffect(() => {
    if (!isCapacitorRuntime() || showOpeningScreen || !currentChannel) return;
    const frame = window.requestAnimationFrame(() => syncNativePlayerBounds(true));
    return () => window.cancelAnimationFrame(frame);
  }, [showOpeningScreen, showLiveMenu, isLivePreviewFullscreen, contentPage, hasSelectedLiveChannel, currentChannel?.id]);

  useEffect(() => {
    // Re-bind to the current video element after major UI mode changes.
    initPlayerEngine();
  }, [showOpeningScreen, activePanel]);

  useEffect(() => {
    const dispatchRefresh = () => {
      const event = new CustomEvent("refreshEPG");
      window.dispatchEvent(event);
    };

    // Keep opening-screen startup local; refresh guide data on the interval or
    // when a content screen explicitly requests it.
    const interval = setInterval(() => {
      if (!showOpeningScreen) dispatchRefresh();
    }, 3 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, [showOpeningScreen]);

  useEffect(() => {
    // Adult/child login restores that profile's saved hide/show. Master and
    // no-login keep the live map so opening is instant like Smarters Pro.
    if (accessLevel === "child") {
      setActiveVisibilityRole("child");
    } else if (accessLevel === "adult") {
      setActiveVisibilityRole("adult");
    } else {
      restoreLiveVisibility();
    }
    setCategoryRefreshTick((tick) => tick + 1);
  }, [accessLevel]);

  useEffect(() => {
    const security = readSetupSecurity();
    

    if (!showOpeningScreen) {
      return;
    }

    // Fire TV: defer channel cache parse, but restore playlist IDs/metadata quickly.
    if (isCapacitorRuntime()) {
      if (startupCacheHydrationCompletedRef.current) {
        return;
      }
      scheduleCapacitorLegacyCachePurge();
      startupCacheHydrationCompletedRef.current = true;
      setActivePanel(null);

      const adultPlaylistId = readStoredItem(ADULT_PLAYLIST_ID_KEY);
      const preferredPlaylistId = resolveStoredPlaylistId();
      if (preferredPlaylistId) {
        setActivePlaylistId(preferredPlaylistId);
      }

      window.setTimeout(() => {
        const playlists = loadPlaylists();
        setHasPlaylists(playlists.length > 0);
        if (!activePlaylistIdRef.current) {
          const deferredId = resolveStoredPlaylistId(playlists);
          if (deferredId) {
            setActivePlaylistId(deferredId);
            writeStoredItem(SHARED_PLAYLIST_ID_KEY, deferredId);
          }
        }
      }, 400);

      // Fire TV/Android: do not prefetch the full movies/series catalog.
      // Persisting ~180k VOD rows OOMs the Stick. Movies/Series load on
      // entry and are capped before they touch memory or IndexedDB.
      return;
    }

    if (startupCacheHydrationCompletedRef.current) {
      return;
    }
    if (security.loginRequired && !accessLevel) {
      // Pre-warm the channel cache in the background so role login is instant.
      void restoreChannelsCache();
      return;
    }
    if (accessLevel === "adult" || accessLevel === "child") {
      return;
    }
    if (startupAutoLoadInFlightRef.current) {
      return;
    }

    const playlists = loadPlaylists();
    const playlistsHydrationPending = isPlaylistsHydrationPending();
    

    // IndexedDB hydration may populate playlists shortly after startup.
    // Wait for hydration events instead of finalizing an empty auto-load path.
    if (playlists.length === 0 && playlistsHydrationPending) {
      return;
    }

    // If channels are already in memory from a same-session load, keep the
    // opening menu visible and align shared playlist state.
    if (getAllChannels().length > 0) {
      startupCacheHydrationCompletedRef.current = true;
      const storedPlaylistId = readStoredItem(SHARED_PLAYLIST_ID_KEY);
      if (storedPlaylistId) setActivePlaylistId(storedPlaylistId);
      // Always land on the main menu at startup, regardless of platform.
      // Content (group/mode) is preloaded so Live TV opens instantly once
      // the user explicitly chooses it from the menu.
      setContentMode("tv");
      setActiveGroup(pickDefaultLiveGroup(getAllChannels()));
      setActivePanel(null);
      return;
    }

    let cancelled = false;
    startupAutoLoadInFlightRef.current = true;

    (async () => {
      
      // 1. Try restoring from local cache for an instant start, but do not
      // block startup for a long time on slow IndexedDB/storage reads.
      const restored = await restoreChannelsCache();
      if (cancelled) return;

      function applyPreparedContent(channelList: any[], playlistId: string, visibilityRole?: "adult" | "child") {
        if (playlistId) setActivePlaylistId(playlistId);
        // Always land on the main menu at startup, regardless of platform.
        // Content (group/mode) is preloaded so Live TV opens instantly once
        // the user explicitly chooses it from the menu.
        setContentMode("tv");
        setActiveGroup(pickDefaultLiveGroup(channelList));
        setActivePanel(null);

        // Defer visibility role application to after initial render (avoids blocking on large playlists)
        if (visibilityRole) {
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(() => setActiveVisibilityRole(visibilityRole));
          } else {
            setTimeout(() => setActiveVisibilityRole(visibilityRole), 0);
          }
        } else {
          setCategoryRefreshTick((tick) => tick + 1);
        }
      }

      if (restored.length > 0) {
        if (isCapacitorRuntime()) {
          trimCapacitorChannelMemoryForLive();
        }
        startupCacheHydrationCompletedRef.current = true;
        const storedPlaylistId =
          readStoredItem(SHARED_PLAYLIST_ID_KEY) || playlists[0]?.id || "";
        applyPreparedContent(restored, storedPlaylistId);
        setChannelUpdateTick((tick) => tick + 1);
        setCategoryRefreshTick((tick) => tick + 1);
        return;
      }

      // Do not fetch from the provider here. Playlist Manager Load is the only
      // download; the next open then restores this cache instantly.
      startupCacheHydrationCompletedRef.current = true;
      setActivePanel(null);
      setShowOpeningScreen(true);
    })().finally(() => {
      if (!cancelled) {
        startupAutoLoadInFlightRef.current = false;
      }
    });

    return () => {
      cancelled = true;
      startupAutoLoadInFlightRef.current = false;
    };
  }, [showOpeningScreen, accessLevel, hasPlaylists, playlistsRevision]);

  useEffect(() => {
    const handler = () => setShowNowNext(true);
    window.addEventListener("showNowNext", handler);
    return () => window.removeEventListener("showNowNext", handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      setCategoryRefreshTick((tick) => tick + 1);
    };

    window.addEventListener("visibilityChanged", handler);
    return () => window.removeEventListener("visibilityChanged", handler);
  }, []);

  useEffect(() => {
    const refresh = () => {
      const playlists = loadPlaylists();
      if (playlists.length === 0) return;

      void (async () => {
        await waitForBackgroundSlot();
        for (const playlist of playlists) {
          try {
            await loadEPGForPlaylist(playlist, { forceRefresh: true });
          } catch {
            // Keep refresh resilient if guide endpoints are temporarily unavailable.
          }
          await waitForBackgroundSlot();
        }
      })();
    };

    window.addEventListener("refreshEPG", refresh);
    return () => window.removeEventListener("refreshEPG", refresh);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<any>;
      const channel = custom.detail;
      const channelId = String(channel?.id || "");
      const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
      if (!isChannelVisible(channelId) || !isGroupVisible(groupName, visibilityScopeFromChannel(channel))) {
        return;
      }

      playChannel(channel);
    };

    window.addEventListener("tuneChannel", handler);
    return () => window.removeEventListener("tuneChannel", handler);
  }, []);

  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  useEffect(() => {
    if (!!(window as any).Capacitor) {
      document.body.classList.add('is-capacitor');
    }
  }, []);

  useEffect(() => {
    if (isWebOsRuntime()) {
      document.body.classList.add("is-webos");
      return () => document.body.classList.remove("is-webos");
    }
    document.body.classList.remove("is-webos");
  }, []);

  useEffect(() => {
    const onPlayerError = (e: Event) => {
      if (suppressPlayerEventsRef.current) return;
      if (!currentChannelRef.current) return;

      const custom = e as CustomEvent<{ message?: string; source?: string }>;
      const message = friendlyPlaybackError(custom.detail?.message) || "Playback failed for this stream.";
      setPlayerStatus(null);
      setPlayerWarning(null);
      setPlayerError(message);
      if (matchesContentMode(currentChannelRef.current, "tv")) {
        scheduleLiveReconnectRef.current("error");
      }
    };

    const onPlayerPlaying = () => {
      if (suppressPlayerEventsRef.current) return;
      if (!currentChannelRef.current) return;

      // Keep UI in live-view state whenever playback is confirmed.
      setShowOpeningScreen(false);
      setPlayerError(null);

      if (playerStatus && /picture-only|video-only/i.test(playerStatus)) {
        setPlayerWarning(playerStatus);
      }

      setPlayerStatus(null);
      setPlayerUiTick((tick) => tick + 1);
      hadLivePlayingRef.current = matchesContentMode(currentChannelRef.current, "tv");
      liveReconnectAttemptRef.current = 0;

      // Native ExoPlayer on Capacitor is fullscreen — bounds sync not needed.
    };

    const onPlayerTranscoding = (e: Event) => {
      if (suppressPlayerEventsRef.current) return;
      if (!currentChannelRef.current) return;

      const custom = e as CustomEvent<{ message?: string }>;
      const message = custom.detail?.message || "Transcoding stream for playback...";
      setPlayerError(null);
      setPlayerStatus(message);

      if (!/picture-only|video-only/i.test(message)) {
        setPlayerWarning(null);
      }
    };

    window.addEventListener("playerError", onPlayerError as EventListener);
    window.addEventListener("playerPlaying", onPlayerPlaying);
    window.addEventListener("playerTranscoding", onPlayerTranscoding as EventListener);
    return () => {
      window.removeEventListener("playerError", onPlayerError as EventListener);
      window.removeEventListener("playerPlaying", onPlayerPlaying);
      window.removeEventListener("playerTranscoding", onPlayerTranscoding as EventListener);
    };
  }, []);

  useEffect(() => {
    const clearTimer = () => {
      if (liveReconnectTimerRef.current !== null) {
        window.clearTimeout(liveReconnectTimerRef.current);
        liveReconnectTimerRef.current = null;
      }
    };

    const schedule = (reason: string) => {
      const ch = currentChannelRef.current;
      if (!ch || !matchesContentMode(ch, "tv")) return;
      if (liveReconnectTimerRef.current !== null) return;
      const delay = Math.min(20000, Math.round(2500 * Math.pow(1.6, Math.min(liveReconnectAttemptRef.current, 8))));
      setPlayerStatus("Connection lost, reconnecting...");
      liveReconnectTimerRef.current = window.setTimeout(() => {
        liveReconnectTimerRef.current = null;
        const next = currentChannelRef.current;
        if (!next || !matchesContentMode(next, "tv")) return;
        if (document.visibilityState === "hidden") {
          schedule("hidden");
          return;
        }
        liveReconnectAttemptRef.current += 1;
        lastPlayRequestRef.current = { id: null, url: null, at: 0 };
        playChannelRef.current(next, { forceRestart: true });
      }, delay);
    };

    scheduleLiveReconnectRef.current = schedule;

    const onReconnect = (event: Event) => {
      if (suppressPlayerEventsRef.current) return;
      const message = (event as CustomEvent<{ message?: string }>).detail?.message || "reconnect";
      schedule(message);
    };

    const onOffline = () => {
      if (!matchesContentMode(currentChannelRef.current, "tv")) return;
      setPlayerStatus("Connection lost, waiting to reconnect...");
    };

    const onOnline = () => {
      clearTimer();
      liveReconnectAttemptRef.current = 0;
      schedule("online");
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!matchesContentMode(currentChannelRef.current, "tv")) return;
      clearTimer();
      schedule("visible");
    };

    const onWaiting = (event: Event) => {
      const video = event.target as HTMLVideoElement | null;
      if (!video || video.id !== "player-main") return;
      if (!hadLivePlayingRef.current) return;
      if (!matchesContentMode(currentChannelRef.current, "tv")) return;
      if (liveReconnectTimerRef.current !== null) return;
      window.setTimeout(() => {
        const current = document.getElementById("player-main") as HTMLVideoElement | null;
        if (!current || current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
        if (!hadLivePlayingRef.current) return;
        schedule("stall");
      }, 8000);
    };

    const onEnded = (event: Event) => {
      const video = event.target as HTMLVideoElement | null;
      if (!video || video.id !== "player-main") return;
      if (!hadLivePlayingRef.current) return;
      if (!matchesContentMode(currentChannelRef.current, "tv")) return;
      schedule("ended");
    };

    window.addEventListener("playerReconnect", onReconnect as EventListener);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("waiting", onWaiting, true);
    document.addEventListener("stalled", onWaiting, true);
    document.addEventListener("ended", onEnded, true);

    return () => {
      scheduleLiveReconnectRef.current = () => {};
      clearTimer();
      window.removeEventListener("playerReconnect", onReconnect as EventListener);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("waiting", onWaiting, true);
      document.removeEventListener("stalled", onWaiting, true);
      document.removeEventListener("ended", onEnded, true);
    };
  }, []);

  useEffect(() => {
      const onPlayerEnded = () => {
      if (suppressPlayerEventsRef.current) return;

      const activeChannel = currentChannelRef.current;
      if (activeChannel) clearVodResume(activeChannel);
      if (!isSeriesEpisodeSelection(activeChannel)) return;

      const activeUrl = String(activeChannel?.url || "");
      if (!activeUrl) return;

      // Guard against duplicate ended events from the same source.
      const now = Date.now();
      if (
        lastSeriesEndedRef.current.url === activeUrl &&
        now - lastSeriesEndedRef.current.at < 2500
      ) {
        return;
      }
      lastSeriesEndedRef.current = { url: activeUrl, at: now };

      const token = ++seriesAutoAdvanceTokenRef.current;
      const continueToNextEpisode = async () => {
        let candidates = Array.isArray(seriesPickerEpisodesRef.current) ? seriesPickerEpisodesRef.current : [];
        let nextEpisode = findNextSeriesEpisode(activeChannel, candidates);

        if (!nextEpisode) {
          try {
            const source = seriesPickerSourceChannelRef.current || activeChannel;
            candidates = await loadXtreamSeriesEpisodesFromChannel(source);
            if (candidates.length > 0) {
              seriesPickerEpisodesRef.current = candidates;
              setSeriesPickerEpisodes(candidates);
            }
          } catch {
            candidates = [];
          }

          if (token !== seriesAutoAdvanceTokenRef.current) return;

          const currentUrl = String(currentChannelRef.current?.url || "");
          if (!currentUrl || currentUrl !== activeUrl) return;

          nextEpisode = findNextSeriesEpisode(activeChannel, candidates);
        }

        if (!nextEpisode) return;

        rememberSeriesEpisode(seriesPickerSourceChannelRef.current || activeChannel, nextEpisode);
        playChannel(nextEpisode, { skipResumePrompt: true, resumeAt: 0 });
      };

      void continueToNextEpisode();
    };

    window.addEventListener("playerEnded", onPlayerEnded);
    return () => {
      window.removeEventListener("playerEnded", onPlayerEnded);
    };
  }, []);

  useEffect(() => {
    const channel = currentChannel;
    if (!channel) return;
    const isVod =
      matchesContentMode(channel, "movies") || matchesContentMode(channel, "series");
    if (!isVod) return;

    let lastSavedAt = 0;
    const save = () => captureVodProgress(channel);
    const onTimeUpdate = () => {
      const now = Date.now();
      if (now - lastSavedAt < 5000) return;
      lastSavedAt = now;
      save();
    };

    const player = document.getElementById("player-main");
    player?.addEventListener("timeupdate", onTimeUpdate);
    player?.addEventListener("pause", save);
    const onHide = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", onHide);

    return () => {
      save();
      player?.removeEventListener("timeupdate", onTimeUpdate);
      player?.removeEventListener("pause", save);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [currentChannel?.id, currentChannel?.url]);

  useEffect(() => {
    if (!isVodPlaybackFullscreen) return;
    const player = document.getElementById("player-main");
    if (!player) return;
    const refresh = () => refreshPlayerUi();
    player.addEventListener("play", refresh);
    player.addEventListener("pause", refresh);
    return () => {
      player.removeEventListener("play", refresh);
      player.removeEventListener("pause", refresh);
    };
  }, [isVodPlaybackFullscreen, currentChannel?.id]);

  useEffect(() => {
    // Helper to handle Back navigation (shared by webosBackKey and keydown)
    const handleBackNavigation = () => {
      const now = Date.now();
      if (now - lastBackHandledAtRef.current < 350) return true;
      lastBackHandledAtRef.current = now;
      
      // Handle Back navigation
      if (vodResumePrompt) {
        setVodResumePrompt(null);
        return true;
      }

      if (document.querySelector(".vod-language-panel")) {
        setAudioLanguagePickerOpen(false);
        window.dispatchEvent(new Event("closeAudioLanguagePicker"));
        return true;
      }

      if (
        isVodPlaybackFullscreen ||
        document.querySelector(".vod-playback-shell") ||
        document.querySelector(".vod-exit-btn")
      ) {
        exitVodPlayback();
        return true;
      }

      if (isSeriesPickerVisible) {
        setIsSeriesPickerVisible(false);
        return true;
      }

      if (isAudioLanguagePickerOpen()) {
        setAudioLanguagePickerOpen(false);
        window.dispatchEvent(new Event("closeAudioLanguagePicker"));
        return true;
      }

      if (isSeriesDetailsVisible) {
        setIsSeriesDetailsVisible(false);
        return true;
      }

      if (isMovieDetailsVisible) {
        setIsMovieDetailsVisible(false);
        return true;
      }

      if (isSeriesSearchComposerOpen) {
        setIsSeriesSearchComposerOpen(false);
        return true;
      }

      if (isMoviesSearchComposerOpen) {
        setIsMoviesSearchComposerOpen(false);
        return true;
      }

      if (String(seriesMainSearchDebouncedTerm || "").trim() || String(moviesMainSearchTerm || "").trim()) {
        clearCatalogSearch();
        return true;
      }

      if (contentPage === "live" && isEffectiveLiveFullscreen) {
        setIsLiveFullscreenRequested(false);
        setShowLiveMenu(true);
        return true;
      }

      if (showOpeningScreen && !activePanel) {
        // On main menu - Back should exit the app
        const isCap = !!(window as any).Capacitor || window.location.hostname === "app";

        if (isWebOsRuntime()) {
          exitWebOsApp();
        } else if (isCap) {
          exitNativeApp();
        }


        // Consume the event even if exit fails to prevent browser history navigation
        return true;
      }


      // Return nested screens to their parent
      if (activePanel) {
        if (activePanel === "recordingPlayback" || activePanel === "recordingStorage") {
          setActivePanel("recordings");
        } else if (activePanel === "playlist" && contentPage === "playlistManager") {
          setActivePanel(null);
        } else {
          setActivePanel(null);
          // Reset the page state so a stale "playlistManager"/"movies"/"series"
          // page cannot leak onto the next screen opened from the main menu.
          setContentPage("live");
          setShowOpeningScreen(true);
        }
        return true;
      } else {
        if (currentChannel && contentPage === "live") {
          exitLivePlaybackToBrowser();
        } else if (currentChannel && (contentPage === "movies" || contentPage === "series" || contentPage === "playlistManager")) {
          stopCurrentVodPlaybackIfNeeded();
          setCurrentChannel(null);
          setContentPage("live");
          setShowOpeningScreen(true);
        } else {
          setContentPage("live");
          setShowOpeningScreen(true);
        }
        return true;
      }
    };

    // Listen for custom webosBackKey event (dispatched by webOS SDK)
    const handleWebosBack = () => {
      if (
        document.querySelector(".vod-playback-shell") ||
        document.querySelector(".vod-exit-btn") ||
        document.querySelector(".vod-language-panel")
      ) {
        handleBackNavigation();
        return;
      }
      if (isRemoteTextComposerOpen()) {
        document.querySelector<HTMLButtonElement>(".remote-text-composer-done")?.click();
        return;
      }
      if (isTextEntryActive() && dismissActiveTextEntry()) {
        return;
      }
      handleBackNavigation();
    };
    
    window.addEventListener("webosBackKey", handleWebosBack);
    document.addEventListener("webosBackKey", handleWebosBack);
    window.addEventListener("capacitorBackKey", handleWebosBack);

    const onKeyboardStateChange = (event: Event) => {
      const detail = (event as CustomEvent<{ visibility?: boolean | string; state?: string }>).detail;
      const visible =
        detail?.visibility === true ||
        detail?.visibility === "visible" ||
        detail?.state === "opened" ||
        detail?.state === "visible";
      if (document.body) {
        document.body.dataset.webosKeyboard = visible ? "open" : "closed";
      }
    };
    document.addEventListener("keyboardStateChange", onKeyboardStateChange);
    
    // Regular keydown handler
    const onKeyDown = (e: KeyboardEvent) => {
      const isBack = isBackKeyEvent(e);
      const composerOpen = isRemoteTextComposerOpen();
      const eraseWhileEditing =
        isTextEraseKey(e) && (isTextEntryActive(e.target) || isPlaylistEditFieldButton(e.target) || composerOpen);

      if (composerOpen && eraseWhileEditing && !isHardwareBackKeyEvent(e)) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>(".remote-text-composer-backspace:not(:disabled)")?.click();
        return;
      }

      if (composerOpen && isBack) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>(".remote-text-composer-done")?.click();
        return;
      }

      // Fire TV IME Erase is Backspace. Do not treat that as app Back.
      if (eraseWhileEditing) {
        return;
      }

      if (isBack && isTextEntryActive(e.target)) {
        e.preventDefault();
        dismissActiveTextEntry();
        return;
      }
      
      if (isBack) {
        // Handle Back here even on webOS. The SDK may also dispatch webosBackKey;
        // handleBackNavigation debounces the duplicate.
        e.preventDefault();
        handleBackNavigation();
        return;
      }
      
      if (isTextEntryTarget(e.target)) return;
      if (document.querySelector(".series-search-composer") || isRemoteTextComposerOpen()) return;

      const navKey = normalizeRemoteNavKey(e);
      if (navKey === "Enter" && isFavoriteFocusTarget(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) activateFocusedRemoteControl(document.activeElement);
        return;
      }

      const mediaKey = normalizeRemoteMediaKey(e);
      if (mediaKey && currentChannel) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("playerRevealControls"));
        if (mediaKey === "MediaPlayPause") {
          togglePlayPause();
        } else if (mediaKey === "MediaPlay") {
          playPlayback();
        } else if (mediaKey === "MediaPause" || mediaKey === "MediaStop") {
          pausePlayback();
        } else if (mediaKey === "MediaRewind") {
          seekPlayback(-15);
        } else if (mediaKey === "MediaFastForward") {
          seekPlayback(15);
        }
        return;
      }

      if (isVodPlaybackFullscreen) {
        window.dispatchEvent(new Event("playerRevealControls"));
        if (document.querySelector(".vod-language-panel")) {
          return;
        }
        if (document.body.classList.contains("native-exo-active")) {
          if (navKey === "ArrowDown" || navKey === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            focusNativePlayerControls();
            return;
          }
          if (navKey === "ArrowLeft" || navKey === "ArrowRight" || navKey === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            revealNativePlayerControls();
            return;
          }
        } else {
        const barButtons = vodPlayBarButtons();
        const barIndex = focusedVodPlayBarIndex(barButtons);
        if (navKey === "ArrowDown" || navKey === "ArrowUp") {
          e.preventDefault();
          focusPlayBarRemoteButton(barButtons[barIndex >= 0 ? barIndex : 0] || null);
          return;
        }
        if (navKey === "ArrowLeft") {
          e.preventDefault();
          if (barIndex < 0) {
            focusPlayBarRemoteButton(barButtons[0] || null);
          } else {
            focusPlayBarRemoteButton(barButtons[Math.max(0, barIndex - 1)] || null);
          }
          return;
        }
        if (navKey === "ArrowRight") {
          e.preventDefault();
          if (barIndex < 0) {
            focusPlayBarRemoteButton(barButtons[0] || null);
          } else {
            focusPlayBarRemoteButton(barButtons[Math.min(barButtons.length - 1, barIndex + 1)] || null);
          }
          return;
        }
        if (navKey === "Enter") {
          e.preventDefault();
          const current = barIndex >= 0 ? barButtons[barIndex] : null;
          if (current) {
            current.click();
          } else {
            togglePlayPause();
          }
          return;
        }
        }
      }

      if (
        currentChannel &&
        (e.key === " " ||
          e.key === "Enter" ||
          e.key === "Select" ||
          e.keyCode === 23 ||
          e.key === "f" ||
          e.key === "F" ||
          e.key === "m" ||
          e.key === "M" ||
          (isLivePreviewFullscreen && (navKey === "ArrowDown" || navKey === "ArrowUp")))
      ) {
        revealNativePlayerControls();
        window.dispatchEvent(new Event("playerRevealControls"));
      }

      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      }

      if (e.key === " " && currentChannel) {
        e.preventDefault();
        togglePlayPause();
      }

      if ((e.key === "m" || e.key === "M") && currentChannel) {
        e.preventDefault();
        toggleMute();
      }
    };

    // Use capture phase so we get the event before webOS shell
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("webosBackKey", handleWebosBack);
      document.removeEventListener("webosBackKey", handleWebosBack);
      window.removeEventListener("capacitorBackKey", handleWebosBack);
      document.removeEventListener("keyboardStateChange", onKeyboardStateChange);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activePanel, isVodPlaybackFullscreen, currentChannel, isSeriesPickerVisible, isSeriesDetailsVisible, isMovieDetailsVisible, vodResumePrompt, contentPage, isEffectiveLiveFullscreen, showOpeningScreen, hasPlaylists, seriesPickerSourceChannel, seriesDetailsChannel, movieDetailsChannel]);

  useEffect(() => {
    const onNativeCommand = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string; paused?: boolean; muted?: boolean }>).detail?.action;
      const detail = (event as CustomEvent<{ action?: string; paused?: boolean; muted?: boolean }>).detail;
      if (action === "fullscreen") {
        toggleFullscreen();
        return;
      }
      if (action === "state") {
        if (typeof detail?.paused === "boolean") noteNativePlaybackPaused(detail.paused);
        if (typeof detail?.muted === "boolean") noteNativePlaybackMuted(detail.muted);
        refreshPlayerUi();
      }
    };
    window.addEventListener("nativePlayerCommand", onNativeCommand);
    return () => window.removeEventListener("nativePlayerCommand", onNativeCommand);
  }, [contentPage]);

  useEffect(() => {
    const onWindowError = (event: ErrorEvent) => {
      const message = event.message || "";
      if (message.includes("ResizeObserver loop completed with undelivered notifications")) {
        event.preventDefault();
      }
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reasonText = String(event.reason || "");
      if (reasonText.includes("ResizeObserver loop completed with undelivered notifications")) {
        event.preventDefault();

      }
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (!isContentIconsView) return;

    // Overlay visibility checkbox on a poster tile (playlist manager grids).
    const tileCheckboxFor = (btn: HTMLElement | null): HTMLElement | null => {
      const wrap = btn?.closest(".channel-icon-wrap");
      const toggle = wrap?.querySelector<HTMLButtonElement>(".list-visibility-toggle");
      if (toggle && !toggle.disabled) return toggle;
      const cb = wrap?.querySelector<HTMLInputElement>('.channel-icon-toggle input[type="checkbox"]');
      return cb && !cb.disabled ? cb : null;
    };
    const tileFavoriteFor = (btn: HTMLElement | null): HTMLButtonElement | null => {
      return btn?.closest(".channel-icon-wrap")?.querySelector<HTMLButtonElement>(".channel-icon-favorite") ?? null;
    };

    const searchToolbarControls = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          ".series-main-search-bar > .series-main-search-btn"
        )
      ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled));

    const groupToolbarControls = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(".group-list .group-list-toolbar .group-list-bulk-btn")
      ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled));

    const toolbarControls = (): HTMLElement[] => {
      const search = searchToolbarControls();
      return search.length > 0 ? search : groupToolbarControls();
    };

    const composerControls = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(".series-search-composer button")
      ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled) && el.offsetParent !== null);

    const focusToolbar = (index = 0): boolean => {
      const buttons = toolbarControls();
      if (buttons.length === 0) return false;
      buttons[Math.max(0, Math.min(index, buttons.length - 1))]?.focus();
      return true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isSeriesPickerVisible) return;
      if (isSeriesDetailsVisible) return;
      if (isMovieDetailsVisible) return;
      if (vodResumePrompt) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl) return;

      const inComposer = !!activeEl.closest(".series-search-composer");
      const inToolbar = !!activeEl.closest(".series-main-search-bar");
      if (isTextEntryTarget(e.target) && !inComposer && !inToolbar) return;

      const key = normalizeRemoteNavKey(e);
      const composerOpen = isSeriesSearchComposerOpen || isMoviesSearchComposerOpen;
      const isOverlayCheckbox =
        !!activeEl.closest(".channel-icon-toggle") &&
        ((activeEl instanceof HTMLInputElement && activeEl.type === "checkbox") ||
          activeEl.classList.contains("list-visibility-toggle"));
      const isFavoriteStar = isFavoriteFocusTarget(activeEl);

      if (
        composerOpen &&
        !e.repeat &&
        !e.isComposing &&
        e.key.length === 1 &&
        /[a-z0-9 ]/i.test(e.key) &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        e.stopPropagation();
        // webOS OK often echoes the focused key as a letter AND a click.
        // Let click/Enter append once; a USB keyboard still works below.
        if (isWebOsRuntime()) return;
        const wanted = e.key === " " ? "Space" : e.key.toUpperCase();
        const focusedLabel = String(activeEl.textContent || "").trim().toUpperCase();
        if (focusedLabel === wanted || (wanted === "SPACE" && focusedLabel === "SPACE")) return;
        const match = Array.from(document.querySelectorAll<HTMLButtonElement>(".series-search-composer button")).find(
          (button) => button.textContent?.trim() === wanted
        );
        if (match) activateFocusedRemoteControl(match);
        return;
      }

      // Remote OK sends Enter; native checkboxes only toggle on Space.
      // Fire TV DPAD_CENTER is keyCode 23 and often will not click a poster unless we do it.
      // webOS often also delivers a pointer click for the same OK press — debounce so
      // a visibility checkbox does not toggle off and straight back on.
      if (key === "Enter") {
        if (e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (inComposer) {
          e.preventDefault();
          e.stopPropagation();
          if (Date.now() - composerOpenedAtRef.current < 400) return;
          activateFocusedRemoteControl(activeEl);
          return;
        }
        if (inToolbar && activeEl instanceof HTMLButtonElement) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(activeEl);
          return;
        }
        if (
          activeEl instanceof HTMLButtonElement &&
          activeEl.classList.contains("group-list-bulk-btn")
        ) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(activeEl);
          return;
        }
        if (composerOpen) {
          e.preventDefault();
          e.stopPropagation();
          document
            .querySelector<HTMLButtonElement>(
              ".series-search-composer-actions .series-main-search-btn:not(:disabled), .series-search-composer .series-search-key"
            )
            ?.focus();
          return;
        }
        if (isOverlayCheckbox) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(activeEl);
          return;
        }
        if (isFavoriteStar) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(activeEl);
          return;
        }
        const wrap = activeEl.closest(".channel-icon-wrap");
        const poster = wrap?.querySelector<HTMLButtonElement>(".channel-icon-btn");
        if (poster && !poster.disabled) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(poster);
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;

      const inIconGrid = !!activeEl.closest(".channel-list-icons");
      const inModeButtons = !!activeEl.closest(".playlist-manager-actions");
      const inGroupList = !!activeEl.closest(".group-list");

      if (inComposer) {
        const controls = composerControls();
        const composerIndex = controls.indexOf(activeEl);
        const actionButtons = Array.from(
          document.querySelectorAll<HTMLElement>(".series-search-composer-actions button")
        ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled) && el.offsetParent !== null);
        const keyButtons = Array.from(
          document.querySelectorAll<HTMLElement>(".series-search-composer-grid .series-search-key")
        ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled) && el.offsetParent !== null);
        const actionIndex = actionButtons.indexOf(activeEl);
        const keyIndex = keyButtons.indexOf(activeEl);
        const firstKeyRect = keyButtons[0]?.getBoundingClientRect();
        const gridRect = keyButtons[0]?.closest(".series-search-composer-grid")?.getBoundingClientRect();
        const keyColumns = firstKeyRect && gridRect
          ? Math.max(1, Math.floor((gridRect.width + 8) / (firstKeyRect.width + 8)))
          : 6;

        if (actionIndex >= 0) {
          e.preventDefault();
          if (key === "ArrowRight") actionButtons[Math.min(actionButtons.length - 1, actionIndex + 1)]?.focus();
          else if (key === "ArrowLeft") actionButtons[Math.max(0, actionIndex - 1)]?.focus();
          else if (key === "ArrowDown") (keyButtons[0] || controls[0])?.focus();
          else if (key === "ArrowUp") {
            if (!focusToolbar(Math.max(0, toolbarControls().length - 1))) {
              actionButtons[0]?.focus();
            }
          }
          return;
        }

        if (keyIndex >= 0) {
          e.preventDefault();
          if (key === "ArrowRight") keyButtons[Math.min(keyButtons.length - 1, keyIndex + 1)]?.focus();
          else if (key === "ArrowLeft") keyButtons[Math.max(0, keyIndex - 1)]?.focus();
          else if (key === "ArrowDown") keyButtons[Math.min(keyButtons.length - 1, keyIndex + keyColumns)]?.focus();
          else if (key === "ArrowUp") {
            if (keyIndex < keyColumns) (actionButtons[actionButtons.length - 1] || actionButtons[0])?.focus();
            else keyButtons[keyIndex - keyColumns]?.focus();
          }
          return;
        }

        if (composerIndex >= 0) {
          e.preventDefault();
          if (key === "ArrowRight") controls[Math.min(controls.length - 1, composerIndex + 1)]?.focus();
          else if (key === "ArrowLeft") controls[Math.max(0, composerIndex - 1)]?.focus();
          else if (key === "ArrowDown") controls[Math.min(controls.length - 1, composerIndex + 1)]?.focus();
          else if (key === "ArrowUp") focusToolbar();
        }
        return;
      }
      const movieButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".channel-list-icons .channel-icon-btn")
      );
      const groupButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".group-list .group-select-btn, .group-list .group-item > button")
      );

      const inert =
        activeEl === document.body ||
        activeEl === document.documentElement ||
        activeEl instanceof HTMLMediaElement;

      if (composerOpen && !inComposer) {
        e.preventDefault();
        document
          .querySelector<HTMLButtonElement>(
            ".series-search-composer-actions .series-main-search-btn:not(:disabled), .series-search-composer .series-search-key"
          )
          ?.focus();
        return;
      }

      if (!inIconGrid && !inModeButtons && !inGroupList && !inToolbar) {
        if (!inert) return;
        e.preventDefault();
        if (focusToolbar()) return;
        (groupButtons.find((button) => button.closest(".group-item.active")) || groupButtons[0] || movieButtons.find((btn) => !btn.disabled) || movieButtons[0])?.focus();
        return;
      }

      if (inGroupList) {
        const bulkButtons = groupToolbarControls();
        const bulkIndex = bulkButtons.indexOf(activeEl);
        if (bulkIndex >= 0) {
          e.preventDefault();
          if (key === "ArrowRight") bulkButtons[Math.min(bulkButtons.length - 1, bulkIndex + 1)]?.focus();
          else if (key === "ArrowLeft") bulkButtons[Math.max(0, bulkIndex - 1)]?.focus();
          else if (key === "ArrowDown") {
            (groupButtons.find((button) => button.closest(".group-item.active")) || groupButtons[0])?.focus();
          } else if (key === "ArrowUp") {
            searchToolbarControls()[0]?.focus();
          }
          return;
        }

        const groupRow = activeEl.closest(".group-item");
        const groupBtn = groupRow?.querySelector<HTMLButtonElement>(".group-select-btn");
        const groupIndex = groupBtn ? groupButtons.indexOf(groupBtn) : groupButtons.indexOf(activeEl as HTMLButtonElement);
        if (groupIndex < 0) {
          if (key === "ArrowDown" || key === "ArrowRight") {
            e.preventDefault();
            (groupButtons[0] || movieButtons.find((btn) => !btn.disabled) || movieButtons[0])?.focus();
          }
          return;
        }
        if (key === "ArrowUp") {
          e.preventDefault();
          if (groupIndex <= 0) {
            if (focusToolbar()) return;
            if (bulkButtons[0]) {
              bulkButtons[0].focus();
              return;
            }
          }
          groupButtons[Math.max(0, groupIndex - 1)]?.focus();
          return;
        }
        if (key === "ArrowDown") {
          e.preventDefault();
          groupButtons[Math.min(groupButtons.length - 1, groupIndex + 1)]?.focus();
          return;
        }
        if (key === "ArrowRight") {
          const firstTile = movieButtons.find((btn) => !btn.disabled) || movieButtons[0];
          if (firstTile) {
            e.preventDefault();
            firstTile.focus();
          }
        }
        return;
      }

      if (inToolbar) {
        const buttons = toolbarControls();
        const toolbarIndex = buttons.indexOf(activeEl);
        if (toolbarIndex >= 0) {
          const index = toolbarIndex;
          if (key === "ArrowRight") {
            e.preventDefault();
            if (index < buttons.length - 1) buttons[index + 1]?.focus();
            return;
          }
          if (key === "ArrowLeft") {
            e.preventDefault();
            if (index > 0) buttons[index - 1]?.focus();
            else {
              const groupBtn =
                groupButtons.find((button) => button.closest(".group-item.active")) || groupButtons[0];
              groupBtn?.focus();
            }
            return;
          }
          if (key === "ArrowDown") {
            e.preventDefault();
            const firstTile = movieButtons.find((btn) => !btn.disabled) || movieButtons[0];
            if (firstTile) firstTile.focus();
            else groupButtons[0]?.focus();
            return;
          }
          if (key === "ArrowUp") {
            e.preventDefault();
            return;
          }
        }
      }

      if (!inIconGrid && !inModeButtons && !inToolbar) return;

      const modeButtons = inModeButtons || (inIconGrid && key === "ArrowUp")
        ? Array.from(document.querySelectorAll<HTMLButtonElement>(".playlist-manager-actions button"))
        : [];

      if (movieButtons.length === 0) return;

      // An overlay checkbox occupies the same grid position as its poster.
      const tileButton = isOverlayCheckbox || activeEl.closest(".channel-icon-wrap")
        ? (activeEl.closest(".channel-icon-wrap")?.querySelector<HTMLButtonElement>(".channel-icon-btn") ?? null)
        : (activeEl as HTMLButtonElement);
      const movieIndex = tileButton ? movieButtons.indexOf(tileButton) : -1;
      const modeIndex = modeButtons.indexOf(activeEl as HTMLButtonElement);

      const firstButtonRect = movieButtons[0]?.getBoundingClientRect();
      const listRect = movieButtons[0]?.closest(".channel-list")?.getBoundingClientRect();
      const columns = firstButtonRect && listRect
        ? Math.max(1, Math.floor((listRect.width + 10) / (firstButtonRect.width + 10)))
        : 1;

      // Land on a tile: prefer its poster button; hidden tiles have disabled
      // posters in the playlist manager, so fall back to their checkbox.
      const focusTile = (index: number): void => {
        const btn = movieButtons[index];
        if (!btn) return;
        const stop = !btn.disabled ? btn : tileCheckboxFor(btn);
        stop?.focus();
      };
      // Stay in the checkbox layer while moving sideways for bulk toggling.
      const focusTileCheckbox = (index: number): void => {
        const btn = movieButtons[index];
        if (!btn) return;
        const stop = tileCheckboxFor(btn) || (!btn.disabled ? btn : null);
        stop?.focus();
      };

      if (modeIndex >= 0) {
        if (key === "ArrowRight" && modeIndex < modeButtons.length - 1) {
          e.preventDefault();
          modeButtons[modeIndex + 1]?.focus();
          return;
        }
        if (key === "ArrowLeft" && modeIndex > 0) {
          e.preventDefault();
          modeButtons[modeIndex - 1]?.focus();
          return;
        }
        if (key === "ArrowDown") {
          e.preventDefault();
          focusTile(0);
          return;
        }
      }

      if (movieIndex >= 0 && isOverlayCheckbox) {
        if (key === "ArrowDown") {
          e.preventDefault();
          // Back to this tile's poster; if it's hidden/disabled, next row down.
          if (tileButton && !tileButton.disabled) tileButton.focus();
          else focusTile(Math.min(movieButtons.length - 1, movieIndex + columns));
          return;
        }
        if (key === "ArrowUp") {
          e.preventDefault();
          if (movieIndex < columns) {
            if (focusToolbar()) return;
            (modeButtons[1] || modeButtons[0])?.focus();
            return;
          }
          focusTile(movieIndex - columns);
          return;
        }
        if (key === "ArrowLeft") {
          if (movieIndex > 0) {
            e.preventDefault();
            focusTileCheckbox(movieIndex - 1);
          }
          return;
        }
        if (key === "ArrowRight") {
          if (movieIndex < movieButtons.length - 1) {
            e.preventDefault();
            focusTileCheckbox(movieIndex + 1);
          }
          return;
        }
        return;
      }

      const focusTileFavorite = (index: number): void => {
        const btn = movieButtons[index];
        if (!btn) return;
        const stop = tileFavoriteFor(btn) || (!btn.disabled ? btn : tileCheckboxFor(btn));
        stop?.focus();
      };

      if (movieIndex >= 0 && isFavoriteStar) {
        const focusActiveGroup = () => {
          const groupBtn =
            groupButtons.find((button) => button.closest(".group-item.active")) || groupButtons[0];
          groupBtn?.focus();
        };

        if (key === "ArrowDown") {
          e.preventDefault();
          if (tileButton && !tileButton.disabled) tileButton.focus();
          else focusTile(Math.min(movieButtons.length - 1, movieIndex + columns));
          return;
        }
        if (key === "ArrowUp") {
          e.preventDefault();
          const cb = tileCheckboxFor(tileButton);
          if (cb) {
            cb.focus();
            return;
          }
          if (movieIndex < columns) {
            if (focusToolbar()) return;
            focusActiveGroup();
            return;
          }
          focusTile(movieIndex - columns);
          return;
        }
        if (key === "ArrowLeft") {
          e.preventDefault();
          if (columns > 1 && movieIndex % columns === 0) {
            focusActiveGroup();
            return;
          }
          if (movieIndex > 0) focusTileFavorite(movieIndex - 1);
          else focusActiveGroup();
          return;
        }
        if (key === "ArrowRight") {
          if (movieIndex < movieButtons.length - 1) {
            e.preventDefault();
            focusTileFavorite(movieIndex + 1);
          }
        }
        return;
      }

      if (movieIndex >= 0) {
        const focusActiveGroup = () => {
          const groupBtn =
            groupButtons.find((button) => button.closest(".group-item.active")) || groupButtons[0];
          groupBtn?.focus();
        };

        if (key === "ArrowUp") {
          e.preventDefault();
          if (movieIndex < columns) {
            if (focusToolbar()) return;
            focusActiveGroup();
            return;
          }
          const fav = tileFavoriteFor(tileButton);
          if (fav) {
            fav.focus();
            return;
          }
          const cb = tileCheckboxFor(tileButton);
          if (cb) {
            cb.focus();
            return;
          }
          focusTile(movieIndex - columns);
          return;
        }

        if (key === "ArrowDown") {
          e.preventDefault();
          focusTile(Math.min(movieButtons.length - 1, movieIndex + columns));
          return;
        }

        if (key === "ArrowLeft") {
          e.preventDefault();
          if (columns > 1 && movieIndex % columns === 0) {
            focusActiveGroup();
            return;
          }
          if (movieIndex > 0) focusTile(movieIndex - 1);
          else focusActiveGroup();
          return;
        }

        if (key === "ArrowRight") {
          if (movieIndex < movieButtons.length - 1) {
            e.preventDefault();
            focusTile(movieIndex + 1);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isContentIconsView, isSeriesPickerVisible, isSeriesDetailsVisible, isMovieDetailsVisible, vodResumePrompt, filteredChannels.length, isSeriesSearchComposerOpen, isMoviesSearchComposerOpen]);

  useEffect(() => {
    if (!isMainMoviesScreen && !isMainSeriesScreen && !isLiveTvView) return;
    if (isSeriesPickerVisible) return;
    if (isSeriesDetailsVisible) return;
    if (isMovieDetailsVisible) return;
    if (vodResumePrompt) return;

    if (isSeriesSearchComposerOpen || isMoviesSearchComposerOpen) return;

    const timer = window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".channel-list-icons, .group-list, .vod-resume-overlay, .series-main-search-bar, .series-search-composer")) return;
      if (posterRestoreId) return;

      const poster = document.querySelector<HTMLButtonElement>(
        ".channel-list-icons .channel-icon-btn:not([disabled])"
      );
      const groupBtn = document.querySelector<HTMLButtonElement>(
        ".group-list .group-item.active .group-select-btn, .group-list .group-select-btn"
      );
      (poster || groupBtn)?.focus();
    }, 80);

    return () => window.clearTimeout(timer);
  }, [isMainMoviesScreen, isMainSeriesScreen, isLiveTvView, isSeriesPickerVisible, isSeriesDetailsVisible, isMovieDetailsVisible, vodResumePrompt, contentPage, channelUpdateTick, posterRestoreId, isSeriesSearchComposerOpen, isMoviesSearchComposerOpen]);

  useEffect(() => {
    if (!isSeriesSearchComposerOpen && !isMoviesSearchComposerOpen) return;
    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLButtonElement>(
          ".series-search-composer-actions .series-main-search-btn:not(:disabled), .series-search-composer .series-search-key"
        )
        ?.focus();
    }, 320);
    return () => window.clearTimeout(timer);
  }, [isSeriesSearchComposerOpen, isMoviesSearchComposerOpen]);

  useEffect(() => {
    if (showOpeningScreen || contentPage !== "live" || activePanel !== null) return;

    const timer = window.setTimeout(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".channel-list, .group-list, .opening-screen, .player-control-bar")) return;
      const channel = document.querySelector<HTMLButtonElement>(
        ".channel-list .channel-icon-btn:not([disabled]), .channel-list .channel-select-btn, .channel-list .channel-row-btn"
      );
      const group = document.querySelector<HTMLButtonElement>(
        ".group-list .group-item.active .group-select-btn, .group-list .group-select-btn"
      );
      (channel || group)?.focus();
    }, 80);

    return () => window.clearTimeout(timer);
  }, [showOpeningScreen, contentPage, activePanel, channelUpdateTick, activeGroup]);

  useEffect(() => {
    // Remote arrow-key navigation for Live TV and Playlist Manager
    // (Live TV / Movies / Series all use the same Master / Groups / Titles lists).
    const remoteListNavActive =
      !showOpeningScreen &&
      activePanel === null &&
      (contentPage === "playlistManager" || (contentPage === "live" && !isContentIconsView));
    if (!remoteListNavActive) return;

    const enabledButton = (row: HTMLElement | null): HTMLButtonElement | null => {
      if (!row) return null;
      if (row instanceof HTMLButtonElement) return row.disabled ? null : row;
      const btn =
        row.querySelector<HTMLButtonElement>(".channel-select-btn, .channel-row-btn, .group-select-btn") ||
        row.querySelector<HTMLButtonElement>("button:not(.channel-list-favorite):not(.channel-icon-favorite)");
      return btn && !btn.disabled ? btn : null;
    };

    const enabledCheckbox = (row: HTMLElement | null): HTMLElement | null => {
      if (!row || row instanceof HTMLButtonElement) return null;
      const toggle = row.querySelector<HTMLButtonElement>(".list-visibility-toggle");
      if (toggle && !toggle.disabled) return toggle;
      const cb = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      return cb && !cb.disabled ? cb : null;
    };

    const enabledFavorite = (row: HTMLElement | null): HTMLButtonElement | null => {
      if (!row || row instanceof HTMLButtonElement) return null;
      const btn = row.querySelector<HTMLButtonElement>(".channel-list-favorite");
      return btn && !btn.disabled ? btn : null;
    };

    const rowStop = (row: HTMLElement | null): HTMLElement | null =>
      enabledButton(row) || enabledCheckbox(row);

    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const key = normalizeRemoteNavKey(e);
      if (isRemoteTextComposerOpen()) {
        if (key === "Enter") {
          if (e.repeat) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(active);
        }
        return;
      }
      const inPlaylistEditForm =
        e.target instanceof HTMLElement && !!e.target.closest(".playlist-edit-form");
      // Keep Left/Right and typing inside edit fields; remotes still need
      // Up/Down to reach Password after Username.
      if (isTextEntryTarget(e.target) && (!inPlaylistEditForm || (key !== "ArrowUp" && key !== "ArrowDown"))) {
        return;
      }

      // Remote OK sends Enter; native checkboxes only toggle on Space.
      if (key === "Enter") {
        if (e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (
          (active instanceof HTMLInputElement && active.type === "checkbox") ||
          (active instanceof HTMLButtonElement && active.classList.contains("list-visibility-toggle"))
        ) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(active);
        } else if (
          active instanceof HTMLButtonElement &&
          (active.classList.contains("channel-list-favorite") ||
            active.classList.contains("epg-favorite-btn") ||
            active.classList.contains("group-list-bulk-btn") ||
            active.classList.contains("series-main-search-btn") ||
            !!active.closest(".playlist-edit-form"))
        ) {
          e.preventDefault();
          e.stopPropagation();
          activateFocusedRemoteControl(active);
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;
      // Fire TV D-pad often sends an immediate repeat; keep one row per press.
      if (e.repeat) {
        e.preventDefault();
        return;
      }

      const modeButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".playlist-manager-actions button")
      );
      const parentalButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".playlist-manager-parental-actions button")
      );
      const saveButton =
        document.querySelector<HTMLButtonElement>(".playlist-manager-save-btn") ||
        parentalButtons[parentalButtons.length - 1] ||
        null;
      const masterRows = Array.from(document.querySelectorAll<HTMLElement>(".master-min-list .group-item"));
      const groupRows = Array.from(document.querySelectorAll<HTMLElement>(".group-list .group-item"));
      const channelRows = Array.from(document.querySelectorAll<HTMLElement>(".channel-list .channel-item"))
        .filter((row) => !row.classList.contains("channel-header-item"));
      const toolbarButtons = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".series-main-search-bar > .series-main-search-btn, .group-list .group-list-toolbar .group-list-bulk-btn"
        )
      ).filter((el) => !(el instanceof HTMLButtonElement && el.disabled));
      const loadMoreBtn = document.querySelector<HTMLElement>(".channel-list .channel-load-more-btn");
      const favoriteBtn =
        document.querySelector<HTMLButtonElement>(".player-control-bar-favorite") ||
        document.querySelector<HTMLButtonElement>(".epg-favorite-btn");
      const cardStops = playlistCardFocusables();
      const onFavorite = !!active && !!favoriteBtn && active === favoriteBtn;
      const cardIndex = active ? cardStops.indexOf(active) : -1;
      const onCard = cardIndex >= 0;
      if (
        modeButtons.length === 0 &&
        masterRows.length === 0 &&
        groupRows.length === 0 &&
        channelRows.length === 0 &&
        !onFavorite &&
        !onCard
      ) {
        return;
      }

      const isCheckbox =
        (active instanceof HTMLInputElement && active.type === "checkbox") ||
        !!active?.classList.contains("list-visibility-toggle");
      const isFavoriteStar = !!active?.classList.contains("channel-list-favorite");
      const findRowIndex = (rows: HTMLElement[]) =>
        rows.findIndex((row) => row === active || (!!active && row.contains(active)));

      const modeIndex = active ? modeButtons.indexOf(active as HTMLButtonElement) : -1;
      const parentalIndex = active ? parentalButtons.indexOf(active as HTMLButtonElement) : -1;
      const toolbarIndex = active ? toolbarButtons.indexOf(active) : -1;
      const masterIndex = findRowIndex(masterRows);
      const groupIndex = findRowIndex(groupRows);
      const channelIndex = findRowIndex(channelRows);
      const onLoadMore = !!active && active === loadMoreBtn;

      const currentMasterStop = () =>
        rowStop(document.querySelector<HTMLElement>(".master-min-list .group-item.active")) ||
        rowStop(masterRows[0] || null);

      const currentGroupStop = () =>
        rowStop(document.querySelector<HTMLElement>(".group-list .group-item.active")) ||
        rowStop(groupRows[0] || null);

      // Keep column identity while moving vertically: checkbox stays in the
      // checkbox column, button stays in the button column.
      const verticalStop = (row: HTMLElement | null): HTMLElement | null => {
        if (!row) return null;
        if (isFavoriteStar) return enabledFavorite(row) || enabledButton(row);
        if (isCheckbox) return enabledCheckbox(row) || enabledButton(row);
        return enabledButton(row) || enabledCheckbox(row);
      };

      const moveTo = (el: HTMLElement | null) => {
        e.preventDefault();
        if (!el) return;
        el.focus();
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch {
          // Older WebViews may not support scrollIntoView options.
        }
      };

      const editForm = document.querySelector<HTMLElement>(".playlist-edit-form");
      if (editForm) {
        const editingCard = editForm.closest(".playlist-card");
        const inForm = !!active && editForm.contains(active);
        const inEditingCard = !!active && !!editingCard?.contains(active);
        const formStops = Array.from(
          editForm.querySelectorAll<HTMLElement>("button, input.playlist-edit-field")
        ).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
        if ((inForm || inEditingCard) && formStops.length > 0) {
          if (isTextEntryTarget(active) && (key === "ArrowLeft" || key === "ArrowRight")) {
            return;
          }
          if (!inForm && key === "ArrowDown" && active?.closest(".playlist-actions")) {
            moveTo(formStops[0]);
            return;
          }
          if (inForm) {
            const index = active ? formStops.indexOf(active) : -1;
            if (key === "ArrowDown") {
              moveTo(formStops[Math.min(formStops.length - 1, Math.max(0, index) + 1)]);
            } else if (key === "ArrowUp") {
              if (index <= 0) {
                const actionButtons = Array.from(
                  editingCard?.querySelectorAll<HTMLButtonElement>(".playlist-actions button") || []
                ).filter((btn) => !btn.disabled && btn.offsetParent !== null);
                moveTo(actionButtons[actionButtons.length - 1] || formStops[0]);
              } else {
                moveTo(formStops[index - 1]);
              }
            } else if (key === "ArrowLeft" || key === "ArrowRight") {
              const current = formStops[Math.max(0, index)];
              const currentTop = current.getBoundingClientRect().top;
              const row = formStops.filter(
                (el) => Math.abs(el.getBoundingClientRect().top - currentTop) < 18
              );
              const rowIndex = row.indexOf(current);
              const next = key === "ArrowRight" ? row[rowIndex + 1] : row[rowIndex - 1];
              moveTo(next || current);
            }
            return;
          }
        }
      }

      // Focus is outside the lists: capture only from inert targets (body,
      // video surface), never steal from other focused buttons (EPG, player).
      if (
        modeIndex < 0 &&
        parentalIndex < 0 &&
        toolbarIndex < 0 &&
        masterIndex < 0 &&
        groupIndex < 0 &&
        channelIndex < 0 &&
        !onLoadMore &&
        !onFavorite &&
        !onCard
      ) {
        const inert =
          !active ||
          active === document.body ||
          active === document.documentElement ||
          active instanceof HTMLMediaElement;
        if (!inert) return;
        moveTo(
          modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
            modeButtons[1] ||
            currentMasterStop() ||
            currentGroupStop() ||
            verticalStop(channelRows[0] || null)
        );
        return;
      }

      if (parentalIndex >= 0) {
        if (key === "ArrowLeft") moveTo(parentalButtons[parentalIndex - 1] || null);
        else if (key === "ArrowRight") moveTo(parentalButtons[parentalIndex + 1] || null);
        else if (key === "ArrowDown") {
          moveTo(
            modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
              modeButtons[1] ||
              currentMasterStop()
          );
        } else if (key === "ArrowUp") {
          e.preventDefault();
        }
        return;
      }

      if (modeIndex >= 0) {
        if (key === "ArrowLeft") moveTo(modeButtons[modeIndex - 1] || null);
        else if (key === "ArrowRight") moveTo(modeButtons[modeIndex + 1] || null);
        else if (key === "ArrowDown") {
          moveTo(firstPlaylistCardButton() || currentMasterStop() || toolbarButtons[0] || currentGroupStop());
        } else if (key === "ArrowUp") {
          moveTo(saveButton || parentalButtons[parentalButtons.length - 1] || parentalButtons[0] || null);
        }
        return;
      }

      if (onCard) {
        if (key === "ArrowLeft" || key === "ArrowRight") {
          moveTo(stepPlaylistCardFocus(active, key) || active);
        } else if (key === "ArrowDown") {
          const next = stepPlaylistCardFocus(active, "ArrowDown");
          if (next) moveTo(next);
          else moveTo(currentMasterStop() || toolbarButtons[0] || currentGroupStop());
        } else if (key === "ArrowUp") {
          const next = stepPlaylistCardFocus(active, "ArrowUp");
          if (next) moveTo(next);
          else {
            moveTo(
              modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
                modeButtons[1] ||
                modeButtons[0] ||
                saveButton ||
                parentalButtons[0] ||
                null
            );
          }
        }
        return;
      }

      if (toolbarIndex >= 0) {
        if (key === "ArrowLeft") moveTo(currentMasterStop() || toolbarButtons[toolbarIndex - 1] || null);
        else if (key === "ArrowRight") moveTo(toolbarButtons[toolbarIndex + 1] || null);
        else if (key === "ArrowDown") moveTo(currentGroupStop());
        else e.preventDefault();
        return;
      }

      if (masterIndex >= 0) {
        if (key === "ArrowUp") {
          if (masterIndex === 0) {
            moveTo(
              lastPlaylistCardButton() ||
                modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
                modeButtons[1] ||
                verticalStop(masterRows[0] || null)
            );
          } else {
            moveTo(verticalStop(masterRows[masterIndex - 1] || null));
          }
        } else if (key === "ArrowDown") {
          moveTo(verticalStop(masterRows[masterIndex + 1] || null));
        } else if (key === "ArrowLeft") {
          if (!isCheckbox) moveTo(enabledCheckbox(masterRows[masterIndex]) || null);
          else e.preventDefault();
        } else {
          if (isCheckbox) moveTo(enabledButton(masterRows[masterIndex]));
          else moveTo(currentGroupStop());
        }
        return;
      }

      if (groupIndex >= 0) {
        const row = groupRows[groupIndex];
        if (key === "ArrowUp") {
          if (groupIndex === 0) {
            moveTo(
              toolbarButtons[0] ||
                currentMasterStop() ||
                lastPlaylistCardButton() ||
                modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
                modeButtons[1] ||
                null
            );
          } else moveTo(verticalStop(groupRows[groupIndex - 1]));
        } else if (key === "ArrowDown") {
          moveTo(verticalStop(groupRows[groupIndex + 1] || null));
        } else if (key === "ArrowLeft") {
          // Row button -> its visibility checkbox, then the Master category column.
          if (!isCheckbox) moveTo(enabledCheckbox(row) || currentMasterStop());
          else moveTo(currentMasterStop() || null);
        } else {
          // Right: checkbox -> row button, button -> channel column.
          if (isCheckbox) moveTo(enabledButton(row));
          else moveTo(verticalStop(channelRows[0] || null) || loadMoreBtn);
        }
        return;
      }

      if (onLoadMore) {
        if (key === "ArrowUp") moveTo(verticalStop(channelRows[channelRows.length - 1] || null));
        else if (key === "ArrowLeft") moveTo(currentGroupStop());
        else e.preventDefault();
        return;
      }

      if (onFavorite) {
        if (key === "ArrowLeft" || key === "ArrowUp") {
          const activeRow = channelRows.find((row) => row.classList.contains("active")) || channelRows[0];
          moveTo(verticalStop(activeRow || null) || currentGroupStop());
        } else {
          e.preventDefault();
        }
        return;
      }

      if (channelIndex >= 0) {
        const row = channelRows[channelIndex];
        if (key === "ArrowUp") {
          if (channelIndex === 0) {
            moveTo(
              currentGroupStop() ||
                toolbarButtons[0] ||
                currentMasterStop() ||
                saveButton ||
                modeButtons.find((button) => button.classList.contains("playlist-mode-active")) ||
                null
            );
          } else {
            moveTo(verticalStop(channelRows[channelIndex - 1] || null));
          }
        } else if (key === "ArrowDown") {
          if (channelIndex === channelRows.length - 1) moveTo(loadMoreBtn);
          else moveTo(verticalStop(channelRows[channelIndex + 1] || null));
        } else if (key === "ArrowLeft") {
          // Star -> title, title -> checkbox, then groups.
          if (isFavoriteStar) moveTo(enabledButton(row));
          else if (!isCheckbox && enabledCheckbox(row)) moveTo(enabledCheckbox(row));
          else moveTo(currentGroupStop());
        } else {
          // Right: checkbox -> title, title -> star, then live Add Favorite / Save.
          if (isCheckbox) moveTo(enabledButton(row));
          else if (!isFavoriteStar && enabledFavorite(row)) moveTo(enabledFavorite(row));
          else moveTo(favoriteBtn || saveButton || parentalButtons[0] || null);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [showOpeningScreen, activePanel, contentPage, contentMode, isContentIconsView]);

  function toggleFavoriteChannel(channel: any) {
    if (!channel) return;
    const now = Date.now();
    if (now - lastFavoriteToggleAtRef.current < 400) return;
    lastFavoriteToggleAtRef.current = now;
    const channelId = String(channel.id || "");
    setChannelFavoriteRecord(channel, !isFavoriteChannelRecord(channel));
    window.setTimeout(() => {
      if (isMovieDetailsVisible || isSeriesDetailsVisible) {
        document.querySelector<HTMLButtonElement>(".movie-details-favorite")?.focus();
        return;
      }
      if (isSeriesPickerVisible) {
        document.querySelector<HTMLButtonElement>(".series-picker-favorite")?.focus();
        return;
      }
      const match = channelId
        ? Array.from(
            document.querySelectorAll<HTMLButtonElement>(".channel-list-favorite, .channel-icon-favorite")
          ).find((btn) => btn.dataset.channelId === channelId)
        : null;
      const fallback = document.querySelector<HTMLButtonElement>(
        ".channel-list-favorite, .channel-icon-favorite, .channel-select-btn, .channel-icon-btn:not([disabled])"
      );
      (match || fallback)?.focus();
    }, 40);
  }

  function normalizePlayableChannelUrl(ch: any): string {
    const rawUrl = String(ch?.url || "");
    if (!rawUrl) return rawUrl;
    const contentType = String(ch?.contentType || "live").toLowerCase();

    // Older loaded Xtream live channels were built with a forced .m3u8 suffix.
    // Newer loaders use the provider's real extension, typically .ts.
    // webOS cannot play raw MPEG-TS, so keep HLS playlists there.
    if (
      contentType === "live" &&
      !isWebOsRuntime() &&
      /\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(rawUrl)
    ) {
      return rawUrl.replace(/\.m3u8(?=\?|$)/i, ".ts");
    }

    // Keep legacy movie m3u8 URLs untouched. Relay/transcode fallback logic now
    // resolves provider-specific container variants (mkv/mp4/ts) more reliably.

    return rawUrl;
  }

  function isTopLevelSeriesSelection(ch: any) {
    const isSeries = String(ch?.contentType || "").toLowerCase() === "series";
    if (!isSeries) return false;

    const hasEpisodeInfo = !!(ch?.episodeInfo && typeof ch.episodeInfo === "object");
    if (hasEpisodeInfo) return false;

    const id = String(ch?.id || "");
    const url = String(ch?.url || "");
    return /^series_\d+$/i.test(id) && /\/series\/[^/]+\/[^/]+\/\d+\.[^/?#]+/i.test(url);
  }

  async function openSeriesEpisodePicker(seriesChannel: any, options?: { reuseLoaded?: boolean }) {
    const seriesId = String(seriesChannel?.id || "");
    const alreadyLoaded =
      !!options?.reuseLoaded &&
      String(seriesPickerSourceChannel?.id || "") === seriesId &&
      (seriesPickerEpisodes.length > 0 || seriesPickerLoading || !!seriesPickerError);

    setPosterRestoreId(seriesId || null);
    if (!options?.reuseLoaded) {
      setSeriesPickerFocusEpisodeId(null);
    }
    setSeriesPickerTitle(String(seriesChannel?.name || "Series"));
    seriesPickerSourceChannelRef.current = seriesChannel;
    setSeriesPickerSourceChannel(seriesChannel);
    setIsSeriesPickerVisible(true);

    if (alreadyLoaded) return;

    setSeriesPickerEpisodes([]);
    setSeriesPickerError(null);
    setSeriesPickerLoading(true);

    try {
      const bundle = await loadXtreamSeriesBundleFromChannel(seriesChannel);
      setSeriesPickerEpisodes(bundle.episodes);
      if (String(seriesDetailsChannel?.id || "") === seriesId || !seriesDetailsChannel) {
        setSeriesDetailsInfo(bundle.info);
      }

      if (bundle.episodes.length === 0) {
        setSeriesPickerError("No episodes found for this series.");
      }
    } catch {
      setSeriesPickerError("Could not load episodes for this series.");
    } finally {
      setSeriesPickerLoading(false);
    }
  }

  async function openSeriesDetails(seriesChannel: any) {
    setPosterRestoreId(String(seriesChannel?.id || "") || null);
    setSeriesDetailsChannel(seriesChannel);
    setSeriesDetailsInfo(null);
    setSeriesDetailsLoading(true);
    setIsSeriesDetailsVisible(true);
    seriesPickerSourceChannelRef.current = seriesChannel;
    setSeriesPickerSourceChannel(seriesChannel);
    setSeriesPickerTitle(String(seriesChannel?.name || "Series"));
    setSeriesPickerEpisodes([]);
    setSeriesPickerError(null);
    setSeriesPickerLoading(true);
    const last = (() => {
      const seriesId = getSeriesRootId(seriesChannel);
      return seriesId ? seriesLastWatchRef.current[seriesId] : null;
    })();
    setSeriesPickerFocusEpisodeId(String(last?.id || "") || null);
    const token = ++seriesDetailsTokenRef.current;

    try {
      const bundle = await loadXtreamSeriesBundleFromChannel(seriesChannel);
      if (token !== seriesDetailsTokenRef.current) return;
      setSeriesDetailsInfo(bundle.info);
      setSeriesPickerEpisodes(bundle.episodes);
      const lastMatch = last
        ? bundle.episodes.find(
            (episode) =>
              String(episode?.id || "") === String(last.id || "") ||
              String(episode?.url || "") === String(last.url || "")
          )
        : null;
      if (lastMatch) {
        setSeriesPickerFocusEpisodeId(String(lastMatch.id || "") || null);
      }
      if (bundle.episodes.length === 0) {
        setSeriesPickerError("No episodes found for this series.");
      }
    } catch {
      if (token !== seriesDetailsTokenRef.current) return;
      setSeriesDetailsInfo(null);
      setSeriesPickerError("Could not load episodes for this series.");
    } finally {
      if (token === seriesDetailsTokenRef.current) {
        setSeriesDetailsLoading(false);
        setSeriesPickerLoading(false);
      }
    }
  }

  async function openMovieDetails(movieChannel: any) {
    setPosterRestoreId(String(movieChannel?.id || "") || null);
    setMovieDetailsChannel(movieChannel);
    setMovieDetailsInfo(null);
    setMovieDetailsLoading(true);
    setIsMovieDetailsVisible(true);
    const token = ++movieDetailsTokenRef.current;

    try {
      const info = await loadXtreamVodInfoFromChannel(movieChannel);
      if (token !== movieDetailsTokenRef.current) return;
      setMovieDetailsInfo(info);
    } catch {
      if (token !== movieDetailsTokenRef.current) return;
      setMovieDetailsInfo(null);
    } finally {
      if (token === movieDetailsTokenRef.current) {
        setMovieDetailsLoading(false);
      }
    }
  }

  function rememberSeriesEpisode(seriesChannel: any, episodeChannel: any) {
    const seriesId = getSeriesRootId(seriesChannel);
    if (!seriesId) return;
    if (!episodeChannel || typeof episodeChannel !== "object") return;
    if (!episodeChannel.url || typeof episodeChannel.url !== "string") return;

    seriesLastWatchRef.current[seriesId] = {
      id: String(episodeChannel.id || ""),
      name: String(episodeChannel.name || ""),
      logo: typeof episodeChannel.logo === "string" ? episodeChannel.logo : undefined,
      url: String(episodeChannel.url),
      group: typeof episodeChannel.group === "string" ? episodeChannel.group : undefined,
      parentGroup:
        typeof episodeChannel.parentGroup === "string"
          ? episodeChannel.parentGroup
          : typeof seriesChannel?.group === "string"
            ? seriesChannel.group
            : undefined,
      episodeInfo:
        episodeChannel.episodeInfo && typeof episodeChannel.episodeInfo === "object"
          ? {
              season:
                typeof episodeChannel.episodeInfo.season === "number"
                  ? episodeChannel.episodeInfo.season
                  : undefined,
              episode:
                typeof episodeChannel.episodeInfo.episode === "number"
                  ? episodeChannel.episodeInfo.episode
                  : undefined,
              title:
                typeof episodeChannel.episodeInfo.title === "string"
                  ? episodeChannel.episodeInfo.title
                  : undefined
            }
          : undefined
    };

    saveSeriesLastWatchMap(seriesLastWatchRef.current);
  }

  function getLastWatchedSeriesEpisode(seriesChannel: any = seriesDetailsChannel || seriesPickerSourceChannel) {
    const episodes = Array.isArray(seriesPickerEpisodes) ? seriesPickerEpisodes : [];
    if (episodes.length === 0) return null;
    const seriesId = getSeriesRootId(seriesChannel);
    const last = seriesId ? seriesLastWatchRef.current[seriesId] : null;
    if (!last) return null;
    const lastId = String(last?.id || "");
    const lastUrl = String(last?.url || "");
    return (
      (lastId ? episodes.find((episode) => String(episode?.id || "") === lastId) : null) ||
      (lastUrl ? episodes.find((episode) => String(episode?.url || "") === lastUrl) : null) ||
      null
    );
  }

  function seriesDetailsPlayLabel() {
    const lastEpisode = getLastWatchedSeriesEpisode();
    if (!lastEpisode) return "Play";
    const season = lastEpisode?.episodeInfo?.season;
    const number = lastEpisode?.episodeInfo?.episode;
    if (typeof season === "number" && typeof number === "number") {
      return `Resume S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`;
    }
    return "Resume";
  }

  function playPreferredSeriesEpisode() {
    const episodes = Array.isArray(seriesPickerEpisodes) ? seriesPickerEpisodes : [];
    if (episodes.length === 0) return;
    const episode = getLastWatchedSeriesEpisode() || episodes[0];
    rememberSeriesEpisode(seriesDetailsChannel || seriesPickerSourceChannel, episode);
    setSeriesPickerFocusEpisodeId(String(episode?.id || "") || null);
    playChannel(episode);
  }

  function playChannel(ch: any, options?: { forceRestart?: boolean; skipResumePrompt?: boolean; resumeAt?: number; skipMovieDetails?: boolean }) {
    if (showOpeningScreen) {
      // Ignore tune attempts until the user leaves the opening screen.
      return;
    }

    const forceRestart = !!options?.forceRestart;
    const isLiveSelectionEarly = matchesContentMode(ch, "tv");
    const requestId = ch?.id ? String(ch.id) : null;
    const sameLiveChannel =
      isLiveSelectionEarly &&
      !!requestId &&
      String(currentChannelRef.current?.id || "") === requestId;

    // First click previews. A later click on the same channel goes fullscreen.
    // Ignore the extra click webOS/simulator often fires with the first select.
    if (sameLiveChannel && !forceRestart) {
      const previewingMs = Date.now() - lastPlayRequestRef.current.at;
      if (!isEffectiveLiveFullscreen && previewingMs > 800) {
        setIsLiveFullscreenRequested(true);
        setShowLiveMenu(false);
      }
      return;
    }

    let capacitorMemoryTrimmed = false;
    if (isCapacitorRuntime() && isLiveSelectionEarly) {
      trimCapacitorChannelMemoryForLive();
      const groupName = (ch?.group && String(ch.group).trim()) || "Uncategorized";
      const beforeCount = getAllChannels().length;
      const afterCount = releaseCapacitorMemoryForLivePlayback(groupName, String(ch?.id || ""));
      capacitorMemoryTrimmed = afterCount < beforeCount;
    }

    if (!ch?.url || typeof ch.url !== "string") {
      const msg = "This channel has no playable stream URL.";
      console.warn(`[playChannel] blocked: ${msg}`);
      setPlayerError(msg);
      return;
    }

    if (isTopLevelSeriesSelection(ch) || matchesContentMode(ch, "movies")) {
      setPosterRestoreId(String(ch?.id || "") || null);
    }

    if (isTopLevelSeriesSelection(ch)) {
      void openSeriesDetails(ch);
      return;
    }

    if (
      matchesContentMode(ch, "movies") &&
      !options?.skipMovieDetails &&
      !options?.forceRestart &&
      options?.resumeAt == null
    ) {
      void openMovieDetails(ch);
      return;
    }

    const isVodSelection =
      matchesContentMode(ch, "movies") || matchesContentMode(ch, "series");
    const resumeAt = options?.resumeAt;
    if (
      isVodSelection &&
      !forceRestart &&
      !options?.skipResumePrompt &&
      resumeAt == null
    ) {
      const saved = getVodResume(ch);
      if (shouldOfferVodResume(saved)) {
        setVodResumePrompt({
          channel: ch,
          position: saved!.position,
          duration: saved!.duration
        });
        return;
      }
    }

    // Guard against rapid duplicate tune events for the same stream.
    const now = Date.now();
    const requestUrl = normalizePlayableChannelUrl(ch);
    const isDuplicateRapidRequest =
      lastPlayRequestRef.current.id === requestId &&
      lastPlayRequestRef.current.url === requestUrl &&
      now - lastPlayRequestRef.current.at < 1500;

    if (isDuplicateRapidRequest && !forceRestart && resumeAt == null) {
      return;
    }

    lastPlayRequestRef.current = {
      id: requestId,
      url: requestUrl,
      at: now
    };

    if (!forceRestart) {
      liveReconnectAttemptRef.current = 0;
      hadLivePlayingRef.current = false;
      if (liveReconnectTimerRef.current !== null) {
        window.clearTimeout(liveReconnectTimerRef.current);
        liveReconnectTimerRef.current = null;
      }
    }

    suppressPlayerEventsRef.current = false;
    setPlayerError(null);
    setPlayerStatus(forceRestart ? "Reconnecting live TV..." : null);
    setPlayerWarning(null);
    const isLiveSelection = matchesContentMode(ch, "tv");

    setCurrentChannel(ch);
    setIsSeriesPickerVisible(false);
    setIsSeriesDetailsVisible(false);
    setIsMovieDetailsVisible(false);
    setActivePanel(null);
    if (isLiveSelection) {
      setHasSelectedLiveChannel(true);
      if (!forceRestart) setShowLiveMenu(true);
    }
    if (!forceRestart) {
      if (isLiveSelection) {
        recordLastWatched("tv", ch);
      } else if (matchesContentMode(ch, "movies")) {
        recordLastWatched("movies", ch);
      } else if (matchesContentMode(ch, "series")) {
        recordLastWatched("series", ch, seriesPickerSourceChannelRef.current);
        if (isSeriesEpisodeSelection(ch)) {
          rememberSeriesEpisode(seriesPickerSourceChannelRef.current || seriesDetailsChannel || ch, ch);
          setSeriesPickerFocusEpisodeId(String(ch?.id || "") || null);
        }
      }
    }

    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (player) {
      player.muted = false;
      player.volume = 1;
    }

    const requestedContentType = (() => {
      const declared = String(ch?.contentType || "").toLowerCase();
      if (declared === "movie" || declared === "series" || declared === "live") {
        return declared;
      }

      // Some playlists omit contentType on VOD entries. Use current UI mode as
      // a stable fallback so movie/series selections still route through VOD
      // playback handling (including local transcode bootstrap).
      if (contentPage === "movies" || contentMode === "movies") return "movie";
      if (contentPage === "series" || contentMode === "series") return "series";
      return "live";
    })();

    if (player && requestedContentType !== "live") {
      try {
        player.focus({ preventScroll: true });
      } catch {
        player.focus();
      }
    }

    const useNativeLivePlayback =
      requestedContentType === "live" &&
      isCapacitorRuntime() &&
      isNativePlayerAvailable();

    // Stop the previous tune immediately so ExoPlayer can clear the last frame
    // before the next live channel or movie starts.
    if (isCapacitorRuntime() && isNativePlayerAvailable() && currentChannelRef.current) {
      stopPlayback();
    }

    const play = () => {
      playUrl(requestUrl, false, false, 0, false, false, false, requestedContentType as "live" | "movie" | "series");
    };

    const playWhenVideoReady = (attempt = 0) => {
      const player = document.getElementById("player-main") as HTMLVideoElement | null;
      if (player) {
        initPlayerEngine();
        play();
        return;
      }

      if (attempt >= 40) {
        setPlayerStatus("Preparing player surface, retrying...");
        return;
      }

      window.setTimeout(() => {
        playWhenVideoReady(attempt + 1);
      }, 100);
    };

    if (useNativeLivePlayback) {
      if (capacitorMemoryTrimmed) {
        setChannelUpdateTick((tick) => tick + 1);
      }
      initPlayerEngine();
      play();
    } else if (isLiveSelection && !showOpeningScreen) {
      // Ensure preview -> live transition has committed before playback starts.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          playWhenVideoReady();
        });
      });
    } else {
      playWhenVideoReady();
    }
    if (typeof resumeAt === "number") {
      if (resumeAt <= 0) {
        clearVodResume(ch);
      } else {
        applyVodResumeSeek(resumeAt);
      }
    }
    setShowNowNext(true);
    setShowOpeningScreen(false);
  }

  function refreshPlayerUi() {
    setPlayerUiTick((tick) => tick + 1);
  }

  function isPlaybackPaused() {
    void playerUiTick;
    if (document.body.classList.contains("native-exo-active")) {
      return isNativePlaybackPaused();
    }
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    return !player || player.paused;
  }

  function isPlaybackMuted() {
    void playerUiTick;
    if (document.body.classList.contains("native-exo-active")) {
      return isNativePlaybackMuted();
    }
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    return !!player && (player.muted || player.volume === 0);
  }

  function playPlayback() {
    if (document.body.classList.contains("native-exo-active")) {
      if (isNativePlaybackPaused()) resumeNativePlayback();
      refreshPlayerUi();
      return;
    }
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player || !player.paused) return;
    void player.play();
    refreshPlayerUi();
  }

  function pausePlayback() {
    if (document.body.classList.contains("native-exo-active")) {
      if (!isNativePlaybackPaused()) pauseNativePlayback();
      refreshPlayerUi();
      return;
    }
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player || player.paused) return;
    player.pause();
    refreshPlayerUi();
  }

  function seekPlayback(deltaSeconds: number) {
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player || !Number.isFinite(player.currentTime)) return;
    let next = player.currentTime + deltaSeconds;
    if (player.seekable && player.seekable.length > 0) {
      const start = player.seekable.start(0);
      const end = player.seekable.end(player.seekable.length - 1);
      next = Math.min(end, Math.max(start, next));
    } else if (Number.isFinite(player.duration) && player.duration > 0) {
      next = Math.min(player.duration - 0.25, Math.max(0, next));
    } else {
      next = Math.max(0, next);
    }
    try {
      player.currentTime = next;
    } catch {
      // Live HLS windows sometimes reject seeks.
    }
    window.dispatchEvent(new Event("playerRevealControls"));
  }

  function togglePlayPause() {
    // While the native ExoPlayer overlay renders video (Fire TV/Android), the
    // WebView video element is empty — route play/pause to the native bridge.
    if (document.body.classList.contains("native-exo-active")) {
      if (isNativePlaybackPaused()) {
        resumeNativePlayback();
      } else {
        pauseNativePlayback();
      }
      refreshPlayerUi();
      return;
    }

    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player) return;

    if (player.paused) {
      void player.play();
      refreshPlayerUi();
      return;
    }

    player.pause();
    refreshPlayerUi();
  }

  function toggleMute() {
    if (document.body.classList.contains("native-exo-active")) {
      setNativeMuted(!isNativePlaybackMuted());
      refreshPlayerUi();
      return;
    }

    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player) return;

    if (player.muted || player.volume === 0) {
      player.muted = false;
      if (player.volume === 0) player.volume = 1;
      refreshPlayerUi();
      return;
    }

    player.muted = true;
    refreshPlayerUi();
  }

  function toggleFullscreen() {
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    const appRoot = document.querySelector(".app-root") as HTMLElement | null;
    if (!player && !appRoot) return;

    // On webOS, native fullscreen can hide HTML overlays (custom control bar).
    // Keep Live TV fullscreen as a CSS layout mode so controls remain visible.
    if (contentPage === "live") {
      setIsLiveFullscreenRequested((prev) => {
        const next = !prev;
        setShowLiveMenu(!next);
        return next;
      });
      return;
    }

    const doc = document as Document & {
      webkitFullscreenElement?: Element;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const target = appRoot || player;
    const targetAny = target as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    const videoAny = player as HTMLVideoElement & {
      webkitRequestFullscreen?: () => Promise<void>;
      webkitEnterFullscreen?: () => void;
    };

    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        void document.exitFullscreen().catch(() => {});
      } else if (doc.webkitExitFullscreen) {
        void doc.webkitExitFullscreen().catch(() => {});
      }
      return;
    }

    if (target?.requestFullscreen) {
      void target.requestFullscreen().catch(() => {});
      return;
    }

    if (targetAny.webkitRequestFullscreen) {
      void targetAny.webkitRequestFullscreen().catch(() => {});
      return;
    }

    if (videoAny?.webkitRequestFullscreen) {
      void videoAny.webkitRequestFullscreen().catch(() => {});
      return;
    }

    if (videoAny?.webkitEnterFullscreen) {
      videoAny.webkitEnterFullscreen();
    }
  }

  function openPanelFromMenu(panel: string) {
    if (panel === "logout") {
      autoLoadTokenRef.current += 1;
      setAccessLevel(null);
      setLoginCodeInput("");
      setLoginError(null);
      setActivePanel(null);
      setShowOpeningScreen(false);
      return;
    }

    if (!canOpenPanelWithSecurity(panel)) {
      return;
    }

    if (panel === "vod") {
      selectContent("movies");
      return;
    }

    if (panel === "series") {
      selectContent("series");
      return;
    }

    if (panel === "playlistManager") {
      setContentPage("playlistManager");
      setActivePanel(null);
      setShowOpeningScreen(false);
      return;
    }

    if (panel === "epgSearch" || panel === "timeline") {
      void openGuidePanel(panel);
      return;
    }

    setActivePanel(panel);
    setShowOpeningScreen(false);
  }

  function sendToPlaylistManager(status?: string) {
    autoLoadTokenRef.current += 1;
    setContentPage("playlistManager");
    setActivePanel(null);
    setShowOpeningScreen(false);
    setPlayerStatus(status || "Open Playlist Manager and choose Load.");
  }

  async function openSavedCapacitorVod(
    content: "movies" | "series",
    keepPlaylistManagerPage: boolean,
    requestToken: number
  ): Promise<boolean> {
    if (!isCapacitorRuntime()) return false;
    const names = getCapacitorVodGroupNames(content);
    if (names.length === 0) return false;
    const targetGroup = names[0];
    setPlayerStatus(`Restoring ${content}…`);
    await loadCapacitorVodGroupChannels(content, targetGroup);
    if (requestToken !== autoLoadTokenRef.current) return true;
    setShowOpeningScreen(false);
    setActivePanel(null);
    setContentMode(content);
    if (!keepPlaylistManagerPage) {
      setContentPage(content);
    }
    setActiveGroup(targetGroup);
    setChannelUpdateTick((tick) => tick + 1);
    setCategoryRefreshTick((tick) => tick + 1);
    setPlayerStatus(null);
    return true;
  }

  function selectContent(content: "tv" | "movies" | "series") {
    if (!canAccessContentByLevel(content)) {
      alert("This profile level cannot open that screen.");
      return;
    }

    if (accessLevel === "adult" || accessLevel === "child") {
      autoLoadTokenRef.current += 1;
      void (async () => {
        const restored = await restoreRoleContentForLogin(accessLevel);
        if (!restored) {
          setLoginError(
            accessLevel === "adult"
              ? "Adult playlist is not assigned or failed to load."
              : "Child playlist is not assigned or failed to load."
          );
          setContentPage("playlistManager");
          setActivePanel(null);
          setShowOpeningScreen(false);
          return;
        }

        // Only stay on the manager page when it is actually on screen; a stale
        // contentPage left over after returning to the main menu must not trap
        // Movies/Series navigation inside the Playlist Manager.
        const keepPlaylistManagerPage = isPlaylistManagerPage;
        const roleChannels = getAllChannels();
        const roleModeChannels = roleChannels.filter((channel) => matchesContentMode(channel, content));

        if (roleModeChannels.length === 0) {
          alert(`Assigned ${accessLevel} playlist has no ${content} entries.`);
          return;
        }

        if (content !== "tv") {
          stopCurrentVodPlaybackIfNeeded();
        }

        setShowOpeningScreen(false);
        setActivePanel(null);
        setContentMode(content);

        if (!keepPlaylistManagerPage) {
          if (content === "tv") setContentPage("live");
          if (content === "movies") setContentPage("movies");
          if (content === "series") setContentPage("series");
        }

        if (content === "tv") {
          setActiveGroup(pickDefaultLiveGroup(roleChannels));
        } else {
          setActiveGroup(pickDefaultContentGroup(roleChannels, content));
        }

        await ensureGuideEPGLoaded();
      })();
      return;
    }

    // Only stay on the manager page when it is actually on screen (see above).
    const keepPlaylistManagerPage = isPlaylistManagerPage;
    const latestChannels = getAllChannels();
    const modeChannels = latestChannels.filter((channel) => matchesContentMode(channel, content));

    if (modeChannels.length === 0) {
      if (latestChannels.length === 0) {
        const playlists = loadPlaylists();
        if (playlists.length === 0) {
          setActivePanel("playlist");
          setShowOpeningScreen(false);
          return;
        }

        void (async () => {
          const requestToken = autoLoadTokenRef.current + 1;
          autoLoadTokenRef.current = requestToken;

          const restored = await restoreChannelsCache();
          if (requestToken !== autoLoadTokenRef.current) return;
          const restoredMode = restored.filter((channel) => matchesContentMode(channel, content));
          if (restoredMode.length > 0) {
            startupCacheHydrationCompletedRef.current = true;
            setChannelUpdateTick((tick) => tick + 1);
            setCategoryRefreshTick((tick) => tick + 1);
            if (content !== "tv") stopCurrentVodPlaybackIfNeeded();
            setShowOpeningScreen(false);
            setActivePanel(null);
            setContentMode(content);
            if (!keepPlaylistManagerPage) {
              if (content === "tv") setContentPage("live");
              if (content === "movies") setContentPage("movies");
              if (content === "series") setContentPage("series");
            }
            setActiveGroup(
              content === "tv" ? pickDefaultLiveGroup(restored) : pickDefaultContentGroup(restored, content)
            );
            return;
          }

          if (content === "tv" && isCapacitorRuntime() && getCapacitorLiveGroupNames().length > 0) {
            const targetGroup = getCapacitorLiveGroupNames()[0];
            await loadCapacitorLiveGroupChannels(targetGroup);
            if (requestToken !== autoLoadTokenRef.current) return;
            const liveRestored = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
            if (liveRestored.length > 0) {
              setChannelUpdateTick((tick) => tick + 1);
              setShowOpeningScreen(false);
              setActivePanel(null);
              setContentMode("tv");
              if (!keepPlaylistManagerPage) setContentPage("live");
              setActiveGroup(targetGroup);
              return;
            }
          }

          if (
            (content === "movies" || content === "series") &&
            (await openSavedCapacitorVod(content, keepPlaylistManagerPage, requestToken))
          ) {
            return;
          }

          sendToPlaylistManager("Open Playlist Manager and choose Load. Live TV, Movies, and Series then open instantly from this save.");
        })();
        return;
      }

      if ((content === "movies" || content === "series") && !isCapacitorRuntime()) {
        void (async () => {
          const requestToken = autoLoadTokenRef.current + 1;
          autoLoadTokenRef.current = requestToken;
          const hydrated = await hydrateCachedVodScope(content);
          if (requestToken !== autoLoadTokenRef.current) return;
          const hydratedMode = hydrated.filter((channel) => matchesContentMode(channel, content));
          if (hydratedMode.length === 0) {
            sendToPlaylistManager(
              `No saved ${content} catalog. Open Playlist Manager and choose Load.`
            );
            return;
          }
          stopCurrentVodPlaybackIfNeeded();
          setShowOpeningScreen(false);
          setActivePanel(null);
          setContentMode(content);
          if (!keepPlaylistManagerPage) {
            setContentPage(content);
          }
          setActiveGroup(pickDefaultContentGroup(hydrated, content));
          setChannelUpdateTick((tick) => tick + 1);
          setCategoryRefreshTick((tick) => tick + 1);
        })();
        return;
      }

      const playlists = loadPlaylists();
      const preferredPlaylistId =
        (activePlaylistId || readStoredItem(SHARED_PLAYLIST_ID_KEY) || playlists[0]?.id || "").trim();
      const orderedPlaylists = [
        ...(preferredPlaylistId
          ? playlists.filter((playlist) => String(playlist.id) === preferredPlaylistId)
          : []),
        ...playlists.filter((playlist) => String(playlist.id) !== preferredPlaylistId)
      ];

      if (orderedPlaylists.length === 0) {
        alert(`No ${content} entries found in the loaded playlist.`);
        return;
      }

      void (async () => {
        const requestToken = autoLoadTokenRef.current + 1;
        autoLoadTokenRef.current = requestToken;

        const scope = content === "tv" ? "live" : content;

        if (isCapacitorRuntime() && (scope === "movies" || scope === "series")) {
          setShowOpeningScreen(false);
          setActivePanel(null);
          setContentMode(content);
          if (!keepPlaylistManagerPage) {
            setContentPage(content === "movies" ? "movies" : "series");
          }
          setPlayerStatus(`Loading ${content}…`);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
          if (requestToken !== autoLoadTokenRef.current) return;
        }

        // Fire TV/Android: the live catalog persists as per-group IndexedDB
        // records. When switching back to TV after a VOD scope replaced the
        // in-memory list, restore a group from IndexedDB instead of
        // re-downloading the whole catalog from the provider.
        if (scope === "live" && isCapacitorRuntime()) {
          const catalogGroups = getCapacitorLiveGroupNames();
          if (catalogGroups.length > 0) {
            setPlayerStatus("Restoring live TV channels…");
            const targetGroup = catalogGroups[0] || "Uncategorized";
            await loadCapacitorLiveGroupChannels(targetGroup);
            if (requestToken !== autoLoadTokenRef.current) return;

            const restoredLive = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
            if (restoredLive.length === 0) {
              sendToPlaylistManager("No saved Live TV catalog. Open Playlist Manager and choose Load.");
              return;
            }
            setPlayerStatus(null);
            setShowOpeningScreen(false);
            setActivePanel(null);
            setContentMode("tv");
            if (!keepPlaylistManagerPage) {
              setContentPage("live");
            }
            setActiveGroup(targetGroup);
            setChannelUpdateTick((tick) => tick + 1);
            setCategoryRefreshTick((tick) => tick + 1);
            return;
          }
        }

        if (
          (scope === "movies" || scope === "series") &&
          (await openSavedCapacitorVod(scope, keepPlaylistManagerPage, requestToken))
        ) {
          return;
        }

        // Fire TV/Android: serve the VOD scope from the persistent IndexedDB
        // cache (warmed by the startup prefetch or a previous load) instead of
        // re-downloading the whole catalog from the provider on every entry.
        if (isCapacitorRuntime() && (scope === "movies" || scope === "series")) {
          setPlayerStatus(`Loading ${content} from the cache…`);
          const cachedScopeChannels = await loadCapacitorVodScopeCache(
            scope,
            orderedPlaylists.map((playlist) => String(playlist.id))
          );
          if (requestToken !== autoLoadTokenRef.current) return;

          if (cachedScopeChannels.length > 0) {
            const cachedRecords = capCapacitorCatalogList(
              cachedScopeChannels.filter((channel) => isChannelRecord(channel))
            );
            setChannels(cachedRecords as any[], "capacitor-vod-cache-load");
            setChannelUpdateTick((tick) => tick + 1);
            setCategoryRefreshTick((tick) => tick + 1);

            setPlayerStatus(null);
            setShowOpeningScreen(false);
            setActivePanel(null);
            setContentMode(content);
            if (!keepPlaylistManagerPage) {
              if (content === "movies") setContentPage("movies");
              if (content === "series") setContentPage("series");
            }
            setActiveGroup(pickDefaultContentGroup(cachedRecords, content));
            return;
          }
        }

        if (!keepPlaylistManagerPage) {
          sendToPlaylistManager(
            `No saved ${content === "tv" ? "Live TV" : content} catalog. Open Playlist Manager and choose Load.`
          );
          return;
        }

        setPlayerStatus(`Loading ${content === "tv" ? "live TV" : content} from Playlist Manager…`);
        for (const playlist of orderedPlaylists) {
          try {
            const scopedChannels = await loadChannelsForPlaylist(playlist, scope);
            if (requestToken !== autoLoadTokenRef.current) return;
            if (!Array.isArray(scopedChannels) || scopedChannels.length === 0) continue;

            if (isCapacitorRuntime() && (scope === "movies" || scope === "series")) {
              void saveCapacitorVodScopeCache(scope, String(playlist.id), capCapacitorCatalogList(scopedChannels));
            }

            let mergedChannels: any[];
            if (isCapacitorRuntime() && scope !== "live") {
              mergedChannels = capCapacitorCatalogList(
                scopedChannels.filter((channel) => isChannelRecord(channel))
              );
            } else {
              const byId = new Map<string, any>();
              latestChannels.forEach((channel) => byId.set(String(channel?.id || ""), channel));
              scopedChannels.forEach((channel) => byId.set(String(channel?.id || ""), channel));
              mergedChannels = Array.from(byId.values()).filter((channel) => isChannelRecord(channel));
            }

            setActivePlaylistId(playlist.id);
            writeStoredItem(SHARED_PLAYLIST_ID_KEY, playlist.id);
            setChannels(mergedChannels as any[], `playlist-manager-${scope}-load`);
            startTransition(() => {
              setChannelUpdateTick((tick) => tick + 1);
              setCategoryRefreshTick((tick) => tick + 1);
            });

            const refreshedModeChannels = mergedChannels.filter((channel) => matchesContentMode(channel, content));
            if (refreshedModeChannels.length === 0) continue;

            setPlayerStatus(null);
            setContentMode(content);
            setActiveGroup(
              content === "tv"
                ? pickDefaultLiveGroup(mergedChannels)
                : pickDefaultContentGroup(mergedChannels, content)
            );
            if (content === "tv") {
              await loadEPGForPlaylist(playlist).catch(() => {});
            }
            return;
          } catch {
            // Try the next playlist candidate.
          }
        }

        setPlayerStatus(`No ${content} entries found. Use Load on a playlist first.`);
      })();
      return;
    }

    if (content !== "tv") {
      stopCurrentVodPlaybackIfNeeded();
    }

    setShowOpeningScreen(false);
    setActivePanel(null);
    setContentMode(content);

    if (!keepPlaylistManagerPage) {
      if (content === "tv") setContentPage("live");
      if (content === "movies") setContentPage("movies");
      if (content === "series") setContentPage("series");
    }

    if (content === "tv") {
      setActiveGroup(pickDefaultLiveGroup(latestChannels));
    } else {
      setActiveGroup(pickDefaultContentGroup(latestChannels, content));
    }
  }

  function handlePlaylistLoaded(channels: any[]) {
    // Playlist Manager Load is the only provider download. Keep saved hide/show
    // so Live TV / Movies / Series open instantly on the next launch.
    autoLoadTokenRef.current += 1;
    setChannelUpdateTick((tick) => tick + 1);
    setContentPage("playlistManager");
    setContentMode("tv");
    setActiveGroup(pickDefaultLiveGroup(channels));
    setShowOpeningScreen(false);
    setActivePanel(null);
    setCategoryRefreshTick((tick) => tick + 1);
    setPlayerStatus("Hide or show categories here, then open Live TV / Movies / Series. They load instantly from this save.");
  }

  function handlePlaylistLoadedWithId(channels: any[], playlistId: string) {
    setActivePlaylistId(playlistId);
    writeStoredItem(SHARED_PLAYLIST_ID_KEY, playlistId);
    handlePlaylistLoaded(channels);
  }

  async function ensureGuideEPGLoaded() {
    const playlists = loadPlaylists();
    if (playlists.length === 0) return;

    const channels = getAllChannels();
    if (channels.length === 0) return;

    const isLikelyLiveChannel = (channel: any) => {
      const contentType = String(channel?.contentType || "").toLowerCase();
      if (contentType === "live") return true;

      const id = String(channel?.id || "").toLowerCase();
      if (id.startsWith("live_")) return true;

      const group = String(channel?.group || "").toLowerCase();
      return group.startsWith("tv:");
    };

    const liveChannels = channels.filter((channel) => isLikelyLiveChannel(channel));
    if (liveChannels.length === 0) return;

    // Scanning EPG coverage across 50k+ channels freezes Fire TV/Capacitor.
    if (isCapacitorRuntime() && liveChannels.length > 3000) {
      for (const playlist of playlists) {
        try {
          await loadEPGForPlaylist(playlist);
        } catch {
          // Try the next playlist source if this one fails.
        }
      }
      setCategoryRefreshTick((tick) => tick + 1);
      return;
    }

    const hasAnyGuideData = () =>
      liveChannels.some((channel) => {
        const epg = getIndexedEPGForChannel(channel);
        return Array.isArray(epg) && epg.length > 0;
      });

    const hasSufficientGuideData = () => {
      const now = Date.now();
      const coverage = liveChannels.filter((channel) => {
        const epg = getIndexedEPGForChannel(channel);
        return Array.isArray(epg) && epg.some((event) => Number(event?.end || 0) > now);
      }).length;
      const minimumCoverage = Math.max(3, Math.ceil(liveChannels.length * 0.1));
      return coverage >= minimumCoverage;
    };

    if (hasSufficientGuideData()) return;

    for (const playlist of playlists) {
      try {
        await loadEPGForPlaylist(playlist);
      } catch {
        // Try the next playlist source if this one fails.
      }

      if (hasSufficientGuideData()) {
        setCategoryRefreshTick((tick) => tick + 1);
        return;
      }
    }

    setCategoryRefreshTick((tick) => tick + 1);
  }

  async function prefetchGuideListingsAheadOfTime() {
    if (guidePrefetchInFlightRef.current) return;

    const xtreamPlaylists = loadPlaylists().filter((playlist) => playlist.type === "xtream");
    if (xtreamPlaylists.length === 0) return;

    const isLikelyLiveChannel = (channel: any) => {
      const contentType = String(channel?.contentType || "").toLowerCase();
      if (contentType === "live") return true;

      const id = String(channel?.id || "").toLowerCase();
      if (id.startsWith("live_")) return true;

      const group = String(channel?.group || "").toLowerCase();
      return group.startsWith("tv:");
    };

    const extractXtreamStreamId = (channelId: string, channelUrl?: string) => {
      const raw = String(channelId || "").trim();
      if (raw) {
        const prefixed = raw.match(/^live_(\d+)$/i);
        if (prefixed) return prefixed[1];
        const numericTail = raw.match(/(\d+)$/);
        if (numericTail) return numericTail[1];
      }

      const fromUrl = String(channelUrl || "").trim();
      if (!fromUrl) return "";

      try {
        const parsed = new URL(fromUrl);
        const segments = parsed.pathname.split("/").filter(Boolean);
        const lastSegment = segments[segments.length - 1] || "";
        const filenameMatch = lastSegment.match(/^(\d+)(?:\.[a-z0-9]+)?$/i);
        if (filenameMatch) return filenameMatch[1];
      } catch {
        // Ignore invalid URLs and try regex fallback.
      }

      const fallbackMatch = fromUrl.match(/(?:^|\/)(\d+)(?:\.[a-z0-9]+)?(?:$|[?#])/i);
      return fallbackMatch ? fallbackMatch[1] : "";
    };

    const missingLiveChannels = getAllChannels()
      .filter((channel) => isLikelyLiveChannel(channel))
      .filter((channel) => {
        const channelId = String(channel?.id || "");
        if (!channelId) return false;
        if (guidePrefetchedIdsRef.current.has(channelId)) return false;
        const epg = getEPGForChannel(channel);
        return !Array.isArray(epg) || epg.length === 0;
      });

    const chunkSize = 500;
    const start =
      missingLiveChannels.length > 0
        ? guidePrefetchCursorRef.current % missingLiveChannels.length
        : 0;

    const candidates =
      missingLiveChannels.length <= chunkSize
        ? missingLiveChannels
        : [
            ...missingLiveChannels.slice(start, start + chunkSize),
            ...missingLiveChannels.slice(0, Math.max(0, start + chunkSize - missingLiveChannels.length))
          ];

    guidePrefetchCursorRef.current = start + candidates.length;

    if (candidates.length === 0) return;

    await waitForBackgroundSlot();

    guidePrefetchInFlightRef.current = true;
    let updated = 0;
    const workerCount = Math.min(getBackgroundConcurrency(10), candidates.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < candidates.length) {
        await yieldToMain();
        const index = cursor;
        cursor += 1;
        const channel = candidates[index];
        const channelId = String(channel?.id || "");
        if (!channelId) continue;

        const streamId = extractXtreamStreamId(channelId, String(channel?.url || ""));
        if (!streamId) continue;

        for (const playlist of xtreamPlaylists) {
          try {
            const data = playlist.data || {};
            const events = await loadXtreamEPGForStream(
              String(data.url || ""),
              String(data.user || ""),
              String(data.pass || ""),
              streamId,
              24
            );

            if (events.length > 0) {
              setEPG(streamId, events);
              setEPG(`live_${streamId}`, events);
              setEPG(channelId, events);
              guidePrefetchedIdsRef.current.add(channelId);
              updated += 1;
              break;
            }
          } catch {
            // Continue trying next playlist.
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      guidePrefetchInFlightRef.current = false;
    }

    if (updated > 0) {
      startTransition(() => {
        setCategoryRefreshTick((tick) => tick + 1);
      });
    }

    return updated;
  }

  async function openGuidePanel(panel: "epgSearch" | "timeline") {
    stopCurrentVodPlaybackIfNeeded();
    exitAnyFullscreen();
    setContentPage("live");
    setContentMode("tv");
    setShowOpeningScreen(false);
    setShowLiveMenu(false);
    setActiveGroup(ROOT_GROUP);
    setActivePanel(panel);

    try {
      await ensureGuideEPGLoaded();
      const hasGuideData = getAllChannels().some((channel) => getEPGForChannel(channel).length > 0);
      if (!hasGuideData) {
        await Promise.race([
          prefetchGuideListingsAheadOfTime(),
          new Promise<void>((resolve) => {
            window.setTimeout(() => resolve(), 3500);
          })
        ]);
      }
    } catch {
      // Keep guide panel open even if background preload fails.
    }
  }

  useEffect(() => {
    if (showOpeningScreen || contentPage !== "live") {
      liveRoleRestoreAttemptRef.current = "";
      return;
    }

    if (accessLevel !== "adult" && accessLevel !== "child") {
      liveRoleRestoreAttemptRef.current = "";
      return;
    }

    if (getAllChannels().length > 0) {
      liveRoleRestoreAttemptRef.current = "";
      return;
    }

    const sharedPlaylistId = (activePlaylistId || readStoredItem(SHARED_PLAYLIST_ID_KEY) || loadPlaylists()[0]?.id || "").trim();
    const attemptKey = `${accessLevel}|${sharedPlaylistId}|${contentPage}`;
    if (liveRoleRestoreAttemptRef.current === attemptKey) return;
    liveRoleRestoreAttemptRef.current = attemptKey;

    void (async () => {
      const restored = await restoreRoleContentForLogin(accessLevel);
      if (!restored) {
        setLoginError(
          accessLevel === "adult"
            ? "Adult visibility/profile could not be applied to the shared playlist."
            : "Child visibility/profile could not be applied to the shared playlist."
        );
      }
    })();
  }, [showOpeningScreen, contentPage, accessLevel, activePlaylistId, categoryRefreshTick]);

  async function startLiveTV() {
    stopPlayback();
    exitAnyFullscreen();
    setCurrentChannel(null);
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setShowNowNext(false);

    const openLiveView = (channels: any[]) => {
      if (isCapacitorRuntime()) {
        pruneCapacitorVisibilityIfBloated();
      }
      setContentPage("live");
      setContentMode("tv");
      setActivePanel(null);
      setShowLiveMenu(true);
      setHasSelectedLiveChannel(false);
      setIsLiveFullscreenRequested(false);
      setShowOpeningScreen(false);
      setActiveGroup(pickDefaultLiveGroup(channels));
      setLoginError(null);
      setPlayerStatus(null);
    };

    if (accessLevel === "adult" || accessLevel === "child") {
      const restoredForRole = await restoreRoleContentForLogin(accessLevel);
      if (restoredForRole) {
        const roleLiveChannels = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
        if (roleLiveChannels.length === 0) {
          setLoginError(`Assigned ${accessLevel} playlist has no live channels.`);
          setShowOpeningScreen(false);
          return;
        }

        openLiveView(roleLiveChannels);
        if (!isCapacitorRuntime()) {
          void ensureGuideEPGLoaded();
        }
        return;
      }

      setLoginError(
        accessLevel === "adult"
          ? "Adult playlist is not assigned or failed to load."
          : "Child playlist is not assigned or failed to load."
      );
      setActivePanel(null);
      setShowOpeningScreen(false);
      return;
    }

    let liveChannels = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));

    if (liveChannels.length === 0) {
      const restored = await restoreChannelsCache();
      liveChannels = restored.filter((channel) => matchesContentMode(channel, "tv"));
      if (liveChannels.length > 0) {
        startupCacheHydrationCompletedRef.current = true;
        setChannelUpdateTick((tick) => tick + 1);
      }
    }

    if (liveChannels.length === 0 && isCapacitorRuntime()) {
      const catalogGroups = getCapacitorLiveGroupNames();
      if (catalogGroups.length > 0) {
        const targetGroup = catalogGroups[0];
        await loadCapacitorLiveGroupChannels(targetGroup);
        liveChannels = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
        if (liveChannels.length > 0) {
          setChannelUpdateTick((tick) => tick + 1);
          openLiveView(liveChannels);
          setActiveGroup(targetGroup);
          return;
        }
      }
    }

    liveChannels = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
    if (liveChannels.length > 0) {
      openLiveView(liveChannels);
      if (!isCapacitorRuntime()) {
        void ensureGuideEPGLoaded();
      }
      return;
    }

    sendToPlaylistManager("No saved Live TV channels. Open Playlist Manager and choose Load.");
  }

  useEffect(() => {
    if (!bootAction) return;
    if (bootAction === "live") {
      void startLiveTV();
      return;
    }
    openPanelFromMenu(bootAction);
    // Apply the lightweight Fire TV menu choice once after App loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  playChannelRef.current = playChannel;

  return (
    <div className={`app-root${isPlaylistManagerPage ? " is-playlist-manager" : ""}${isPlaylistManagerPage ? " has-master-min-list" : ""}`}>
      {shouldRenderMainVideo && useLivePreviewShell && (
        <div className={`live-preview-shell${isLivePreviewFullscreen ? " live-preview-shell-fullscreen" : ""}`} aria-hidden="false">
            <video
              id="player-main"
              className={`player-main player-main-shell-video${currentChannel ? " player-main-native-controls" : ""}`}
              playsInline
              controls={false}
              disablePictureInPicture={true}
              disableRemotePlayback={true}
              tabIndex={isCapacitorRuntime() || isWebOsRuntime() ? -1 : 0}
              style={{ background: 'transparent', zIndex: 0 }}
            />
            {currentChannel && (
              <PlayerControlBar
                channel={currentChannel}
                paused={isPlaybackPaused()}
                muted={isPlaybackMuted()}
                fullscreen={isLivePreviewFullscreen}
                isFavorite={isFavoriteChannelRecord(currentChannel)}
                onPlayPause={togglePlayPause}
                onMute={toggleMute}
                onFullscreen={toggleFullscreen}
                onToggleFavorite={() => toggleFavoriteChannel(currentChannel)}
              />
            )}
        </div>
      )}
      {shouldRenderMainVideo && useVodPlaybackShell && (
        <div className="vod-playback-shell" aria-hidden="false">
          <video
            id="player-main"
            className="player-main player-main-shell-video player-main-live"
            playsInline
            controls={false}
            disablePictureInPicture={true}
            disableRemotePlayback={true}
            tabIndex={isCapacitorRuntime() || isWebOsRuntime() ? -1 : 0}
            style={{ background: "transparent", zIndex: 0 }}
          />
          {currentChannel && (
            <PlayerControlBar
              mode="vod"
              channel={currentChannel}
              paused={isPlaybackPaused()}
              muted={isPlaybackMuted()}
              fullscreen
              isFavorite={isFavoriteChannelRecord(currentChannel)}
              onPlayPause={togglePlayPause}
              onMute={toggleMute}
              onFullscreen={toggleFullscreen}
              onToggleFavorite={() => toggleFavoriteChannel(currentChannel)}
              onStop={exitVodPlayback}
            />
          )}
          <VodLanguageSelect visible={isVodPlaybackFullscreen} />
        </div>
      )}
      {shouldRenderMainVideo && !useLivePreviewShell && !useVodPlaybackShell && (
        <video
          id="player-main"
          className={`player-main ${shouldShowOpeningMenu && !currentChannel ? "player-main-idle" : showContentPreviewWindow ? "player-main-preview" : contentPage === "live" ? (isEffectiveLiveFullscreen ? "player-main-live" : "player-main-compact") : currentChannel ? "player-main-live" : "player-main-compact"}${forceLivePreviewLayout ? " player-main-force-preview" : ""}`}
          playsInline
          controls={!!currentChannel && !forceLivePreviewLayout && !isWebOsRuntime()}
          disablePictureInPicture={contentPage === "live"}
          disableRemotePlayback={contentPage === "live"}
          tabIndex={isCapacitorRuntime() || isWebOsRuntime() ? -1 : 0}
          style={{ background: 'transparent', zIndex: 0 }}
        />




      )}
      {forceLivePreviewLayout && !isPlaylistInputPanelOpen && (
        <div className="live-preview-placeholder" aria-hidden="true">
          <div className="live-preview-placeholder-title">Live TV Preview</div>
          <div className="live-preview-placeholder-subtitle">Select a channel to start playback</div>
        </div>
      )}
      {showContentPreviewWindow && !useVodPlaybackShell && (
        <div className="player-preview-badge" aria-hidden="true">Preview</div>
      )}
      {showIdlePlayerStatus && (
        <div className="player-status">
          {allChannels.length > 0 ? "No channels available in this view." : "Open Playlist Manager and choose Load."}
        </div>
      )}
      {playerStatus && (currentChannel || isPlaylistManagerPage) && (
        <div className="player-status player-status-info">{playerStatus}</div>
      )}
      {currentChannel && !playerStatus && playerWarning && <div className="player-status player-status-info">{playerWarning}</div>}
      {currentChannel && playerError && <div className="player-status player-status-error">{playerError}</div>}
      {isVodPlaybackFullscreen && !useVodPlaybackShell && (
        <>
          <VodExitButton visible={isVodPlaybackFullscreen} onExit={exitVodPlayback} />
          <VodLanguageSelect visible={isVodPlaybackFullscreen} />
        </>
      )}

      {isLoginOverlayVisible && (
        <div className="app-login-overlay" role="dialog" aria-modal="true" aria-label="Login required">
          <div className="app-login-card">
            <h2 className="app-login-title">Login Required</h2>
            <p className="app-login-subtitle">Enter your 4-character code</p>
            <input
              type="password"
              maxLength={4}
              value={loginCodeInput}
              onChange={(event) => setLoginCodeInput(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submitLoginCode();
                }
              }}
              className="app-login-input"
              aria-label="Login code"
            />
            {loginError && <div className="form-error">{loginError}</div>}
            <button type="button" className="btn-primary app-login-btn" onClick={submitLoginCode}>
              Login
            </button>
          </div>
        </div>
      )}

      <MainMenuScreen
        visible={shouldShowOpeningMenu}
        hasPlaylists={hasPlaylists || hasPlayableChannels}
        playlistsHydrationPending={isPlaylistsHydrationPending()}
        totalCount={channelsByMode.tv.length + channelsByMode.movies.length + channelsByMode.series.length}
        liveCount={channelsByMode.tv.length}
        movieCount={channelsByMode.movies.length}
        seriesCount={channelsByMode.series.length}
        onStartLive={() => {
          void startLiveTV();
        }}
        onOpenPanel={openPanelFromMenu}
      />

      {!shouldShowOpeningMenu && (!isLiveChannelPlaying || showLiveMenu) && (
        <div
          className="vod-browse-layer"
          hidden={isVodPlaybackFullscreen || isMovieDetailsVisible || isSeriesDetailsVisible}
          aria-hidden={isVodPlaybackFullscreen || isMovieDetailsVisible || isSeriesDetailsVisible}
        >
          {isLiveTvView && (
            <div className="series-main-search-bar">
              <button
                type="button"
                className="series-main-search-btn"
                onClick={() => setGroupSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                aria-label={groupSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
              >
                {groupSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
              </button>
            </div>
          )}
          {isMainSeriesScreen && (
            <div className="series-main-search-bar">
              {!isSeriesSearchComposerOpen && (
                <>
                  <button
                    type="button"
                    className="series-main-search-btn"
                    onClick={() => setSeriesSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                    aria-label={seriesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
                  >
                    {seriesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
                  </button>
                  <button
                    type="button"
                    className="series-main-search-btn"
                    onClick={openSeriesSearchComposer}
                  >
                    {seriesMainSearchDebouncedTerm.trim() ? seriesMainSearchDebouncedTerm.trim() : "Search"}
                  </button>
                  {seriesMainSearchDebouncedTerm.trim() && (
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => {
                        commitSeriesMainSearch("");
                        seriesDraftRef.current = "";
                      }}
                    >
                      Clear
                    </button>
                  )}
                </>
              )}
              {isSeriesSearchComposerOpen && (
                <div className="series-search-composer" role="dialog" aria-label="Series search composer">
                  <div className="series-search-composer-value">
                    {seriesMainSearchDraft || "Search series"}
                  </div>
                  <div className="series-search-composer-actions">
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={backspaceSeriesSearchDraft}
                      disabled={seriesMainSearchDraft.length === 0}
                    >
                      Backspace
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => {
                        seriesDraftRef.current = "";
                        resetComposerTextEditGuard();
                        setSeriesMainSearchDraft("");
                        commitSeriesMainSearch("");
                      }}
                      disabled={seriesMainSearchDraft.length === 0}
                    >
                      Clear Draft
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => appendSeriesSearchDraft(" ")}
                      disabled={seriesMainSearchDraft.length >= 32}
                    >
                      Space
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={applySeriesSearchDraft}
                    >
                      Apply
                    </button>
                  </div>
                  <div className="series-search-composer-grid">
                    {SERIES_SEARCH_KEY_ROWS.flat().map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="series-search-key"
                        onClick={() => appendSeriesSearchDraft(key)}
                        disabled={seriesMainSearchDraft.length >= 32}
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                  <span className="series-main-search-hint" aria-live="polite">
                    Build the term with buttons, then choose Apply to search all unhidden series
                  </span>
                </div>
              )}
            </div>
          )}
          {isMainMoviesScreen && (
            <div className="series-main-search-bar">
              {!isMoviesSearchComposerOpen && (
                <>
                  <button
                    type="button"
                    className="series-main-search-btn"
                    onClick={() => setMoviesSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                    aria-label={moviesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
                  >
                    {moviesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
                  </button>
                  <button
                    type="button"
                    className="series-main-search-btn"
                    onClick={openMoviesSearchComposer}
                  >
                    {moviesMainSearchTerm.trim() ? moviesMainSearchTerm.trim() : "Search"}
                  </button>
                  {moviesMainSearchTerm.trim() && (
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => {
                        moviesDraftRef.current = "";
                        setMoviesMainSearchTerm("");
                        setMoviesMainSearchDraft("");
                        setMoviesMainSearchResults(null);
                        setMoviesSearchBusy(false);
                      }}
                    >
                      Clear
                    </button>
                  )}
                </>
              )}
              {isMoviesSearchComposerOpen && (
                <div className="series-search-composer" role="dialog" aria-label="Movies search composer">
                  <div className="series-search-composer-value">
                    {moviesMainSearchDraft || "Search movies"}
                  </div>
                  <div className="series-search-composer-actions">
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={backspaceMoviesSearchDraft}
                      disabled={moviesMainSearchDraft.length === 0}
                    >
                      Backspace
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => {
                        moviesDraftRef.current = "";
                        resetComposerTextEditGuard();
                        setMoviesMainSearchDraft("");
                      }}
                      disabled={moviesMainSearchDraft.length === 0}
                    >
                      Clear Draft
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={() => appendMoviesSearchDraft(" ")}
                      disabled={moviesMainSearchDraft.length >= 64}
                    >
                      Space
                    </button>
                    <button
                      type="button"
                      className="series-main-search-btn"
                      onClick={applyMoviesSearchDraft}
                    >
                      Apply
                    </button>
                  </div>
                  <div className="series-search-composer-grid">
                    {SERIES_SEARCH_KEY_ROWS.flat().map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="series-search-key"
                        onClick={() => appendMoviesSearchDraft(key)}
                        disabled={moviesMainSearchDraft.length >= 64}
                      >
                        {key}
                      </button>
                    ))}
                  </div>
                  <span className="series-main-search-hint" aria-live="polite">
                    Build the term with buttons, then choose Apply to search all unhidden movies
                  </span>
                </div>
              )}
            </div>
          )}
          {isPlaylistManagerPage ? (
            <div className="playlist-columns-scroller">
              <div className="playlist-columns-track">
                <MasterMinList
                  groups={groups}
                  groupCounts={groupCounts}
                  selectedKey={selectedMasterKey}
                  isGroupVisible={(group) => isGroupVisible(group, contentMode)}
                  onToggleCategory={(groupNames, visible) => {
                    setGroupsVisible(groupNames, visible, false, contentMode);
                    setCategoryRefreshTick((tick) => tick + 1);
                  }}
                  onSelectKey={(key) => {
                    setSelectedMasterKey(key);
                    const match = firstGroupForMasterKey(groups, key);
                    if (match) setActiveGroup(match);
                  }}
                />
                <GroupList
                  groups={groupsForList}
                  groupCounts={groupCounts}
                  activeGroup={activeGroup}
                  onSelect={(group) => {
                    selectBrowseGroup(group);
                  }}
                  isGroupVisible={(group) => isGroupVisible(group, contentMode)}
                  onToggleGroupVisible={(group, visible) => {
                    setGroupVisible(group, visible, contentMode);
                    setCategoryRefreshTick((tick) => tick + 1);
                  }}
                  showVisibilityControls={isPlaylistManagerPage}
                  className={isMainMoviesScreen ? "group-list-movies-right" : ""}
                  batchSize={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage) ? 60 : undefined}
                  autoLoadOnScroll={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage)}
                  sortDirection={groupSortDirection}
                  onSortDirectionChange={setGroupSortDirection}
                  showSortButton
                  showBulkVisibilityButtons
                  onSetAllVisible={(visible) => {
                    setGroupsVisible(groupsForList, visible, true, contentMode);
                    setCategoryRefreshTick((tick) => tick + 1);
                  }}
                />
                <ChannelList
                  channels={filteredChannelsForDisplay}
                  onSelect={playChannel}
                  activeChannel={currentChannel}
                  isChannelVisible={isChannelVisible}
                  onToggleChannelVisible={(channelId, visible) => {
                    setChannelVisible(channelId, visible);
                    setCategoryRefreshTick((tick) => tick + 1);
                  }}
                  isFavoriteChannel={(channel) => isFavoriteChannelRecord(channel)}
                  onToggleFavorite={toggleFavoriteChannel}
                  showVisibilityControls={isPlaylistManagerPage}
                  showFavoriteControls={false}
                  showAsIcons={false}
                  batchSize={
                    isCapacitorRuntime() ? 40 : undefined
                  }
                  suppressLogos={false}
                  autoLoadOnScroll={isCapacitorRuntime()}
                  listClassName=""
                  restoreChannelId={!isVodPlaybackFullscreen && !isSeriesPickerVisible && !isSeriesDetailsVisible && !isMovieDetailsVisible ? posterRestoreId : null}
                />
              </div>
            </div>
          ) : (
            <>
          <GroupList
            groups={groupsForList}
            groupCounts={groupCounts}
            activeGroup={activeGroup}
            onSelect={(group) => {
              selectBrowseGroup(group);
            }}
            isGroupVisible={(group) => isGroupVisible(group, contentMode)}
            onToggleGroupVisible={(group, visible) => {
              setGroupVisible(group, visible, contentMode);
              setCategoryRefreshTick((tick) => tick + 1);
            }}
            showVisibilityControls={isPlaylistManagerPage}
            className={isMainMoviesScreen ? "group-list-movies-right" : ""}
            batchSize={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage) ? 60 : undefined}
            autoLoadOnScroll={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage)}
            sortDirection={groupSortDirection}
            onSortDirectionChange={setGroupSortDirection}
            showSortButton={false}
            onSetAllVisible={
              isPlaylistManagerPage
                ? (visible) => {
                    setGroupsVisible(groups, visible, true, contentMode);
                    setCategoryRefreshTick((tick) => tick + 1);
                  }
                : undefined
            }
          />
          <ChannelList
            channels={filteredChannelsForDisplay}
            onSelect={playChannel}
            activeChannel={currentChannel}
            isChannelVisible={isChannelVisible}
            onToggleChannelVisible={(channelId, visible) => {
              setChannelVisible(channelId, visible);
              setCategoryRefreshTick((tick) => tick + 1);
            }}
            isFavoriteChannel={(channel) => isFavoriteChannelRecord(channel)}
            onToggleFavorite={toggleFavoriteChannel}
            showVisibilityControls={isPlaylistManagerPage}
            showFavoriteControls={isLiveContentPage || isContentIconsView}
            showAsIcons={isContentIconsView}
            batchSize={
              (isLiveTvView || isSeriesPage || isMainMoviesScreen) && isContentIconsView
                ? 25
                : undefined
            }
            suppressLogos={false}
            autoLoadOnScroll={
              ((isLiveTvView || isSeriesPage || isMainMoviesScreen) && isContentIconsView)
            }
            listClassName={
              isSeriesPage && isContentIconsView
                ? "channel-list-series-grid"
                : isLiveTvView && isContentIconsView
                  ? "channel-list-live-grid"
                  : isMainMoviesScreen && isContentIconsView
                    ? "channel-list-movies-grid"
                    : ""
            }
            restoreChannelId={!isVodPlaybackFullscreen && !isSeriesPickerVisible && !isSeriesDetailsVisible && !isMovieDetailsVisible ? posterRestoreId : null}
          />
            </>
          )}
        </div>
      )}

      {!shouldShowOpeningMenu && !isEpgSearchPanelOpen && !isLivePreviewFullscreen && currentChannel && (String(currentChannel.contentType || "").toLowerCase() === "live" || (!currentChannel.contentType && contentPage === "live")) && (
        <>
          <EPGGrid
            currentChannel={currentChannel}
            className={useLivePreviewShell ? "epg-grid-preview-window" : ""}
            onOpenGuide={() => {
              void openGuidePanel("epgSearch");
            }}
          />
          {!useLivePreviewShell && (
          <button
            type="button"
            className="epg-favorite-btn"
            onClick={() => {
              if (!currentChannel) return;
              toggleFavoriteChannel(currentChannel);
            }}
          >
            {isFavoriteChannelRecord(currentChannel) ? "Remove Favorite" : "Add Favorite"}
          </button>
          )}
        </>
      )}
      {!shouldShowOpeningMenu && (
        <SeriesDetailsScreen
          visible={isSeriesDetailsVisible && !isSeriesPickerVisible}
          series={seriesDetailsChannel}
          info={seriesDetailsInfo}
          loading={seriesDetailsLoading}
          episodes={seriesPickerEpisodes}
          episodesLoading={seriesPickerLoading}
          episodesError={seriesPickerError}
          focusEpisodeId={seriesPickerFocusEpisodeId}
          playLabel={seriesDetailsPlayLabel()}
          lastEpisodeId={String(getLastWatchedSeriesEpisode()?.id || seriesPickerFocusEpisodeId || "") || null}
          favoriteLabel={
            isFavoriteChannelRecord(seriesDetailsChannel) ? "Remove Favorite" : "Add Favorite"
          }
          onClose={() => setIsSeriesDetailsVisible(false)}
          onToggleFavorite={() => {
            if (!seriesDetailsChannel) return;
            toggleFavoriteChannel(seriesDetailsChannel);
          }}
          onPlay={() => {
            playPreferredSeriesEpisode();
          }}
          onSelectEpisode={(episode) => {
            rememberSeriesEpisode(seriesDetailsChannel, episode);
            setSeriesPickerFocusEpisodeId(String(episode?.id || "") || null);
            playChannel(episode);
          }}
        />
      )}
      {!shouldShowOpeningMenu && (
        <SeriesEpisodePicker
          visible={isSeriesPickerVisible}
          seriesTitle={seriesPickerTitle}
          episodes={seriesPickerEpisodes}
          loading={seriesPickerLoading}
          error={seriesPickerError}
          focusEpisodeId={seriesPickerFocusEpisodeId}
          onClose={() => setIsSeriesPickerVisible(false)}
          favoriteLabel={
            isFavoriteChannelRecord(seriesPickerSourceChannel)
              ? "Remove Favorite"
              : "Add Favorite"
          }
          onToggleFavorite={() => {
            if (!seriesPickerSourceChannel) return;
            toggleFavoriteChannel(seriesPickerSourceChannel);
          }}
          onSelectEpisode={(episode) => {
            rememberSeriesEpisode(seriesPickerSourceChannel, episode);
            setSeriesPickerFocusEpisodeId(String(episode?.id || "") || null);
            playChannel(episode);
          }}
        />
      )}
      {!shouldShowOpeningMenu && (
        <MovieDetailsScreen
          visible={isMovieDetailsVisible}
          movie={movieDetailsChannel}
          info={movieDetailsInfo}
          loading={movieDetailsLoading}
          favoriteLabel={
            isFavoriteChannelRecord(movieDetailsChannel) ? "Remove Favorite" : "Add Favorite"
          }
          onClose={() => setIsMovieDetailsVisible(false)}
          onToggleFavorite={() => {
            if (!movieDetailsChannel) return;
            toggleFavoriteChannel(movieDetailsChannel);
          }}
          onPlay={() => {
            if (!movieDetailsChannel) return;
            playChannel(movieDetailsChannel, { skipMovieDetails: true });
          }}
        />
      )}
      <VodResumePrompt
        visible={!!vodResumePrompt}
        title={String(vodResumePrompt?.channel?.name || "")}
        position={vodResumePrompt?.position || 0}
        onContinue={() => {
          const pending = vodResumePrompt;
          if (!pending) return;
          setVodResumePrompt(null);
          playChannel(pending.channel, { resumeAt: pending.position });
        }}
        onRestart={() => {
          const pending = vodResumePrompt;
          if (!pending) return;
          setVodResumePrompt(null);
          playChannel(pending.channel, { resumeAt: 0 });
        }}
      />
      {!shouldShowOpeningMenu && (
        <PanelsHost
          activePanel={activePanel}
          setActivePanel={setActivePanel}
          showPlaylistManager={isPlaylistManagerPage}
          visibleTvChannels={visibleTvChannels}
          visibleTvGuideChannels={visibleTvGuideChannels}
          visibilityVersion={categoryRefreshTick}
          onSelectContent={selectContent}
          onPlaylistLoadedWithId={handlePlaylistLoadedWithId}
          onPlaylistAdded={() => {
            setHasPlaylists(loadPlaylists().length > 0);
          }}
          activePlaylistId={activePlaylistId}
          onPlaylistsChanged={() => {
            setCategoryRefreshTick(tick => tick + 1);
          }}
          onExitToMainMenu={() => {
            setActivePanel(null);
            setShowOpeningScreen(true);
          }}
          contentMode={contentMode}
        />
      )}

      {!shouldShowOpeningMenu && (
        <NowNextOverlay
          channel={currentChannel}
          visible={showNowNext}
          onHide={() => setShowNowNext(false)}
        />
      )}
    </div>
  );
}

function resolveContentMode(channel: any): "tv" | "movies" | "series" {
  // First, use explicit contentType if available (from Xtream/proper loaders)
  if (channel?.contentType) {
    const contentTypeMap: Record<string, "tv" | "movies" | "series"> = {
      "live": "tv",
      "movie": "movies",
      "series": "series"
    };
    const mappedType = contentTypeMap[channel.contentType];
    if (mappedType) return mappedType;
  }

  // Fallback: use keyword-based detection for channels without explicit type
  const text = `${String(channel?.group || "")} ${String(channel?.name || "")}`.toLowerCase();
  const isMovie = hasAnyKeyword(text, [
    "movie",
    "movies",
    "vod",
    "film",
    "films",
    "cinema",
    "ppv"
  ]);
  const isSeries = hasAnyKeyword(text, [
    "series",
    "show",
    "shows",
    "season",
    "episode",
    "episodes",
    "serial"
  ]);

  if (isMovie && !isSeries) return "movies";
  if (isSeries && !isMovie) return "series";
  if (isMovie && isSeries) {
    // Mixed labels like "Movies / Series" should still surface movie entries.
    return "movies";
  }

  return "tv";
}

function matchesContentMode(channel: any, mode: "tv" | "movies" | "series") {
  return resolveContentMode(channel) === mode;
}

function hasAnyKeyword(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String((target as HTMLInputElement).type || "text").toLowerCase();
  return type !== "checkbox" && type !== "radio" && type !== "button" && type !== "submit";
}

function isVisiblePlaylistCardStop(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement | HTMLInputElement).disabled) return false;
  if (el.offsetParent === null) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
}

function playlistCardButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".playlist-card button")).filter(
    (btn) => isVisiblePlaylistCardStop(btn)
  );
}

function playlistCardFocusables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".playlist-card button, .playlist-card .playlist-edit-form input")
  ).filter((el) => isVisiblePlaylistCardStop(el));
}

function firstPlaylistCardButton(): HTMLButtonElement | null {
  const loaded = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".playlist-card-loaded button")
  ).find((btn) => isVisiblePlaylistCardStop(btn));
  return loaded || playlistCardButtons()[0] || null;
}

function lastPlaylistCardButton(): HTMLButtonElement | null {
  const buttons = playlistCardButtons();
  return buttons[buttons.length - 1] || null;
}

function stepPlaylistCardFocus(
  active: HTMLElement | null,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
): HTMLElement | null | undefined {
  const stops = playlistCardFocusables();
  if (stops.length === 0) return undefined;
  const index = active ? stops.indexOf(active) : -1;
  if (index < 0) return undefined;

  const current = stops[index];
  const currentRect = current.getBoundingClientRect();
  const sameRow = (el: HTMLElement) =>
    Math.abs(el.getBoundingClientRect().top - currentRect.top) < 18;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const row = stops.filter(sameRow);
    const rowIndex = row.indexOf(current);
    const next = key === "ArrowRight" ? row[rowIndex + 1] : row[rowIndex - 1];
    return next || current;
  }

  const downward = key === "ArrowDown";
  const candidates = stops.filter((el) => {
    const top = el.getBoundingClientRect().top;
    return downward ? top > currentRect.top + 10 : top < currentRect.top - 10;
  });
  if (candidates.length === 0) {
    const linear = downward ? stops[index + 1] : stops[index - 1];
    return linear || null;
  }

  const center = currentRect.left + currentRect.width / 2;
  candidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    const primary = downward ? aRect.top - bRect.top : bRect.top - aRect.top;
    if (Math.abs(primary) > 12) return primary;
    const da = Math.abs(aRect.left + aRect.width / 2 - center);
    const db = Math.abs(bRect.left + bRect.width / 2 - center);
    return da - db;
  });
  return candidates[0];
}

function vodPlayBarButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(".vod-playback-shell [data-playbar-btn]")
  );
}

function focusedVodPlayBarIndex(buttons: HTMLButtonElement[]): number {
  const remote = buttons.findIndex((btn) => btn.classList.contains("is-remote-focused"));
  if (remote >= 0) return remote;
  const active = document.activeElement;
  return active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
}

function focusPlayBarRemoteButton(btn: HTMLButtonElement | null): void {
  document.querySelectorAll(".is-remote-focused").forEach((el) => {
    el.classList.remove("is-remote-focused");
  });
  if (!btn) return;
  btn.classList.add("is-remote-focused");
  try {
    btn.focus({ preventScroll: true });
  } catch {
    btn.focus();
  }
}

function isFavoriteFocusTarget(el: Element | null): el is HTMLButtonElement {
  return (
    el instanceof HTMLButtonElement &&
    (el.classList.contains("channel-list-favorite") ||
      el.classList.contains("channel-icon-favorite") ||
      el.classList.contains("epg-favorite-btn") ||
      el.classList.contains("player-control-bar-favorite") ||
      el.classList.contains("series-picker-favorite") ||
      el.classList.contains("movie-details-favorite"))
  );
}

function isSeriesEpisodeSelection(channel: any): boolean {
  if (!channel || typeof channel !== "object") return false;
  if (String(channel?.contentType || "").toLowerCase() !== "series") return false;

  const id = String(channel?.id || "");
  if (/^series_\d+_episode_\d+$/i.test(id)) return true;

  const episodeInfo = channel?.episodeInfo;
  return !!(episodeInfo && typeof episodeInfo === "object");
}

function isChannelRecord(channel: any): channel is Record<string, any> {
  return !!channel && typeof channel === "object";
}

function isUnhiddenContentChannel(channel: any): boolean {
  if (!isChannelRecord(channel)) return false;
  const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
  return isGroupVisible(groupName, visibilityScopeFromChannel(channel)) && isChannelVisible(String(channel.id || ""));
}

function searchableCatalogTitle(name: string): string {
  const raw = String(name || "").toLowerCase().trim();
  const parts = raw.split(/\s[-–]\s/);
  if (parts.length >= 2 && parts[0].length <= 24 && !/\(\d{4}\)/.test(parts[0])) {
    return parts.slice(1).join(" - ").trim() || raw;
  }
  return raw;
}

function compactSearchText(value: string): string {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function catalogSearchRank(name: string, group: string, term: string): number {
  const query = String(term || "").trim().toLowerCase();
  if (!query) return -1;

  const title = String(name || "").toLowerCase();
  const core = searchableCatalogTitle(title);
  const grp = String(group || "").toLowerCase();
  const compactTerm = compactSearchText(query);
  const compactCore = compactSearchText(core);
  const compactTitle = compactSearchText(title);

  if (
    core.startsWith(query) ||
    title.startsWith(query) ||
    (compactTerm && (compactCore.startsWith(compactTerm) || compactTitle.startsWith(compactTerm)))
  ) {
    return 0;
  }

  const tokens = `${core} ${title}`.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((token) => token.startsWith(query))) return 1;
  if (query.length === 1) return -1;
  if (
    core.includes(query) ||
    title.includes(query) ||
    (compactTerm && (compactCore.includes(compactTerm) || compactTitle.includes(compactTerm)))
  ) {
    return 2;
  }
  if (grp.includes(query)) return 3;
  return -1;
}

function rankCatalogSearchMatches(channels: any[], term: string, direction: ItemSortDirection): any[] {
  const query = String(term || "").trim().toLowerCase();
  if (!query) return [];

  const strong: Array<{ channel: any; rank: number; name: string }> = [];
  const weak: Array<{ channel: any; rank: number; name: string }> = [];

  for (const channel of channels) {
    if (!isChannelRecord(channel)) continue;
    const rank = catalogSearchRank(String(channel.name || ""), String(channel.group || ""), query);
    if (rank < 0) continue;
    const entry = { channel, rank, name: String(channel.name || "") };
    if (rank <= 1) strong.push(entry);
    else if (weak.length < MAX_WEAK_SEARCH_RESULTS) weak.push(entry);
  }

  const compare = (
    left: { rank: number; name: string },
    right: { rank: number; name: string }
  ) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    const comparison = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
      numeric: true
    });
    if (!direction || direction === "asc") return comparison;
    return -comparison;
  };

  strong.sort(compare);
  weak.sort(compare);
  return [...strong.slice(0, MAX_SERIES_SEARCH_RESULTS), ...weak].map((entry) => entry.channel);
}

function getSeriesRootId(channel: any): string | null {
  const id = String(channel?.id || "");
  const directMatch = id.match(/^series_(\d+)$/i);
  if (directMatch) return directMatch[1];

  const episodeMatch = id.match(/^series_(\d+)_episode_\d+$/i);
  if (episodeMatch) return episodeMatch[1];

  return null;
}

function findNextSeriesEpisode(currentEpisode: any, episodes: any[]): any | null {
  if (!Array.isArray(episodes) || episodes.length === 0) return null;

  const currentId = String(currentEpisode?.id || "");
  const currentUrl = String(currentEpisode?.url || "");

  let currentIndex = episodes.findIndex((episode) => String(episode?.id || "") === currentId);
  if (currentIndex < 0 && currentUrl) {
    currentIndex = episodes.findIndex((episode) => String(episode?.url || "") === currentUrl);
  }

  if (currentIndex >= 0 && currentIndex + 1 < episodes.length) {
    return episodes[currentIndex + 1];
  }

  const season = Number(currentEpisode?.episodeInfo?.season);
  const episode = Number(currentEpisode?.episodeInfo?.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;

  const ordered = episodes
    .map((item, index) => ({
      item,
      index,
      season: Number(item?.episodeInfo?.season),
      episode: Number(item?.episodeInfo?.episode)
    }))
    .filter((entry) => Number.isFinite(entry.season) && Number.isFinite(entry.episode))
    .sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      if (a.episode !== b.episode) return a.episode - b.episode;
      return a.index - b.index;
    });

  const nextByNumber = ordered.find(
    (entry) => entry.season > season || (entry.season === season && entry.episode > episode)
  );

  return nextByNumber?.item || null;
}

function loadSeriesLastWatchMap(): Record<string, any> {
  try {
    const raw = localStorage.getItem(SERIES_LAST_WATCH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function saveSeriesLastWatchMap(map: Record<string, any>) {
  try {
    localStorage.setItem(SERIES_LAST_WATCH_KEY, JSON.stringify(map));
  } catch {
    // Ignore persistence failures.
  }
}
