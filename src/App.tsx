/* @refresh reload */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChannelList } from "./ui/ChannelList";
import { EPGGrid } from "./ui/EPGGrid";
import { PanelsHost } from "./ui/PanelsHost";
import { useProfile } from "./profiles/ProfileContext";
import { initNavigation } from "./core/navigation";
import { normalizeRemoteNavKey } from "./core/remoteKeys";
import { initPlayerEngine, playUrl, stopPlayback } from "./core/playerEngine";
import {
  isNativePlayerAvailable,
  playNativeUrl,
  stopNativePlayback
} from "./core/nativePlayerBridge";
import { isCapacitorRuntime } from "./core/player/platformDetection";
import { GroupList } from "./ui/GroupList";
import { sortChannelsByName, type ItemSortDirection } from "./ui/groupSorting";
import {
  getAllChannels,
  getGroups,
  isFavoriteChannelRecord,
  isChannelVisible,
  isGroupVisible,
  applyVisibilitySnapshotForCurrentChannels,
  getLastChannelWriteTrace,
  resetVisibilityForCurrentChannels,
  restoreChannelsCache,
  setChannelFavoriteRecord,
  setChannelVisible,
  setChannels,
  trimCapacitorChannelMemoryForLive,
  releaseCapacitorMemoryForLivePlayback,
  getCapacitorLiveGroupNames,
  getCapacitorLiveGroupCounts,
  loadCapacitorLiveGroupChannels,
  ingestCapacitorLiveChannelCatalog,
  ingestCapacitorLiveChannelCatalogAsync,
  scheduleCapacitorLegacyCachePurge,
  pruneCapacitorVisibilityIfBloated,
  setRoleChannelWriteLock,
  setGroupVisible,
  setGroupsVisible,
  setActiveVisibilityRole,
  type ChannelVisibilitySnapshot
} from "./core/channelStore";
import NowNextOverlay from "./ui/NowNextOverlay";
import { isPlaylistsHydrationPending, loadPlaylists } from "./core/playlistStore";
import { loadEPGForPlaylist } from "./core/loaders/epgLoader";
import { getEPG, getEPGForChannel, getIndexedEPGForChannel, setEPG } from "./core/epgStore";
import { loadRecordings } from "./core/recordingEngine";
import MainMenuScreen from "./ui/MainMenuScreen";
import { loadChannelsForPlaylist, loadFromAnyPlaylist } from "./core/loaders/playlistLoader";
import { loadXtream, loadXtreamSeriesEpisodesFromChannel } from "./core/loaders/xtreamLoader";
import { loadXtreamEPGForStream } from "./core/loaders/xtreamEPG";
import SeriesEpisodePicker from "./ui/SeriesEpisodePicker";

const ROOT_GROUP = "Favorites";
const MAX_SERIES_SEARCH_RESULTS = 120;
const MAX_SERIES_SEARCH_SCAN = 40000;
const SERIES_SEARCH_MIN_TERM_LENGTH = 3;
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

function isWebOsRuntime(): boolean {
  const agent = String(navigator?.userAgent || "");
  const runtime = (window as Window & { webOS?: unknown; PalmServiceBridge?: unknown }).webOS;
  return /WebOSTV|webOS|LG WebOS/i.test(agent) || Boolean(runtime) || Boolean((window as Window & { PalmServiceBridge?: unknown }).PalmServiceBridge);
}

function isBackKeyEvent(event: KeyboardEvent): boolean {
  const key = String(event.key || "");
  if (
    key === "Backspace" ||
    key === "Escape" ||
    key === "BrowserBack" ||
    key === "GoBack" ||
    key === "Back" ||
    key === "XF86Back" ||
    key === "Return"
  ) {
    return true;
  }

  const keyCode = Number((event as unknown as { keyCode?: number }).keyCode || 0);
  return keyCode === 4 || keyCode === 8 || keyCode === 27 || keyCode === 461 || keyCode === 10009;
}

export function App() {
  useEffect(() => {
    const debugLog = (window as any).webosDebugLog;
    if (debugLog) debugLog('React App mounted!');
    if (!isCapacitorRuntime()) {
      loadRecordings();
    } else {
      window.setTimeout(() => loadRecordings(), 5000);
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
  const [showOpeningScreen, setShowOpeningScreen] = useState(true);
  const [categoryRefreshTick, setCategoryRefreshTick] = useState(0);
  const [channelUpdateTick, setChannelUpdateTick] = useState(0);  // Track channel data changes separately
  const [favoritesRefreshTick, setFavoritesRefreshTick] = useState(0);
  const [activeGroup, setActiveGroup] = useState(ROOT_GROUP);
  const [contentMode, setContentMode] = useState<"tv" | "movies" | "series">("tv");
  const [showLiveMenu, setShowLiveMenu] = useState(true);
  const [hasSelectedLiveChannel, setHasSelectedLiveChannel] = useState(false);
  const [isFullscreenActive, setIsFullscreenActive] = useState(false);
  const [isLiveFullscreenRequested, setIsLiveFullscreenRequested] = useState(false);
  const [isSeriesPickerVisible, setIsSeriesPickerVisible] = useState(false);
  const [seriesPickerLoading, setSeriesPickerLoading] = useState(false);
  const [seriesPickerError, setSeriesPickerError] = useState<string | null>(null);
  const [seriesPickerTitle, setSeriesPickerTitle] = useState("");
  const [seriesPickerEpisodes, setSeriesPickerEpisodes] = useState<any[]>([]);
  const [seriesPickerSourceChannel, setSeriesPickerSourceChannel] = useState<any | null>(null);
  const [isSeriesSearchComposerOpen, setIsSeriesSearchComposerOpen] = useState(false);
  const [seriesMainSearchDraft, setSeriesMainSearchDraft] = useState("");
  const [seriesMainSearchDebouncedTerm, setSeriesMainSearchDebouncedTerm] = useState("");
  const [seriesMainSearchResults, setSeriesMainSearchResults] = useState<any[] | null>(null);
  const [moviesMainSearchTerm, setMoviesMainSearchTerm] = useState("");
  const [moviesSortDirection, setMoviesSortDirection] = useState<ItemSortDirection>(() => {
    try {
      const saved = localStorage.getItem(MOVIES_SORT_DIRECTION_KEY);
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
    !showOpeningScreen && (isSeriesPage || isPlaylistManagerSeriesMode) && !isSeriesPickerVisible;
  const isEpgSearchPanelOpen = activePanel === "epgSearch";
  const isContentIconsView = isMoviesPage || isSeriesPage || isPlaylistManagerMoviesMode || isPlaylistManagerSeriesMode;
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
  const shouldRenderMainVideo = !isPlaylistInputPanelOpen && !isEpgSearchPanelOpen;
  const useLivePreviewShell = shouldRenderMainVideo && contentPage === "live";
  const isLiveChannelPlaying =
    !showOpeningScreen &&
    !!currentChannel &&
    matchesContentMode(currentChannel, "tv") &&
    contentPage === "live";
  const currentChannelRef = useRef<any | null>(null);
  const suppressPlayerEventsRef = useRef(false);
  const seriesLastWatchRef = useRef<Record<string, any>>(loadSeriesLastWatchMap());
  const lastPlayRequestRef = useRef<{ id: string | null; url: string | null; at: number }>({
    id: null,
    url: null,
    at: 0
  });
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
    const refreshPlaylistsPresence = () => {
      setHasPlaylists(loadPlaylists().length > 0);
      setPlaylistsRevision((revision) => revision + 1);
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
    if (accessLevel === "adult" || accessLevel === "child") {
      setRoleChannelWriteLock(accessLevel);
      return;
    }

    setRoleChannelWriteLock(null);
  }, [accessLevel]);

  useEffect(() => {
    if (!isCapacitorRuntime() || contentPage !== "live") return;
    if (!activeGroup || activeGroup === ROOT_GROUP) return;

    let cancelled = false;
    void (async () => {
      const loaded = await loadCapacitorLiveGroupChannels(activeGroup);
      if (!cancelled && loaded.length > 0) {
        setChannelUpdateTick((tick) => tick + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeGroup, contentPage]);

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
        const groupSet = new Set<string>([ROOT_GROUP]);
        contentChannels.forEach((channel) => {
          const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
          groupSet.add(groupName);
        });
        return Array.from(groupSet);
      }

      const capacitorGroups = getCapacitorLiveGroupNames();
      if (capacitorGroups.length > 0) {
        return [ROOT_GROUP, ...capacitorGroups];
      }
    }

    const groupSet = new Set<string>([ROOT_GROUP]);
    contentChannels.forEach((channel) => {
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      groupSet.add(groupName);
    });
    return Array.from(groupSet);
  }, [contentChannels, contentMode, channelUpdateTick, currentChannel]);
  const visibleGroups = useMemo(() => {
    return groups.filter((group) => isGroupVisible(group));
  }, [groups, categoryRefreshTick]);
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
        return isGroupVisible(groupName) && isChannelVisible(String(channel.id || ""));
      });
    }

    return visibleBuckets;
  }, [channelsByMode, categoryRefreshTick]);
  const visibleChannels = useMemo(() => {
    return visibleChannelsByMode[contentMode];
  }, [visibleChannelsByMode, contentMode]);
  const visibleTvChannels = visibleChannelsByMode.tv;
  const visibleTvGuideChannels = visibleTvChannels;
  const groupsForList = useMemo(() => {
    const useVisibleOnly =
      isLiveContentPage || isMainMoviesScreen || (isMainSeriesScreen && !isPlaylistManagerPage);
    return useVisibleOnly ? visibleGroups : groups;
  }, [isLiveContentPage, isMainMoviesScreen, isMainSeriesScreen, isPlaylistManagerPage, visibleGroups, groups]);
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = { [ROOT_GROUP]: 0 };

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

    for (const channel of contentChannels) {
      if (!isChannelRecord(channel)) continue;
      if (isFavoriteChannelRecord(channel)) counts[ROOT_GROUP] += 1;

      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      counts[groupName] = (counts[groupName] || 0) + 1;
    }

    return counts;
  }, [contentChannels, contentMode, favoritesRefreshTick, channelUpdateTick, currentChannel]);
  const channelsForScope = useMemo(() => {
    return isLiveContentPage ? visibleChannels : contentChannels;
  }, [isLiveContentPage, visibleChannels, contentChannels]);
  const filteredChannels = useMemo(() => {
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
  }, [channelsForScope, contentChannels, activeGroup, categoryRefreshTick, favoritesRefreshTick]);
  const searchableSeriesChannels = useMemo(() => {
    if (!isMainSeriesScreen) return [] as any[];
    return contentChannels.filter((channel) => {
      if (!isChannelRecord(channel)) return false;
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      return isGroupVisible(groupName);
    });
  }, [isMainSeriesScreen, contentChannels, categoryRefreshTick]);
  const searchableSeriesIndex = useMemo(() => {
    return searchableSeriesChannels.slice(0, MAX_SERIES_SEARCH_SCAN).map((channel, index) => {
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
      const visibleMovies = movies.filter((channel) => {
        const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
        return isGroupVisible(groupName);
      });

      const scopedMovies =
        activeGroup === ROOT_GROUP
          ? movies.filter((channel) => isFavoriteChannelRecord(channel))
          : visibleMovies.filter((channel) => {
              const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
              return groupName === activeGroup;
            });

      const filteredMovies = !term
        ? scopedMovies
        : scopedMovies.filter((channel) => {
        const name = String(channel?.name || "").toLowerCase();
        const group = String(channel?.group || "").toLowerCase();
        return `${name} ${group}`.includes(term);
      });

      return sortChannelsByName(filteredMovies, moviesSortDirection);
    }

    if (!isMainSeriesScreen) return filteredChannels;
    if (activeGroup === ROOT_GROUP) {
      return filteredChannels;
    }

    const visibleSeriesChannels = filteredChannels.filter((channel) => {
      if (!isChannelRecord(channel)) return false;
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      return isGroupVisible(groupName);
    });
    const term = String(seriesMainSearchDebouncedTerm || "").trim().toLowerCase();
    if (!term) return visibleSeriesChannels;
    if (term.length < SERIES_SEARCH_MIN_TERM_LENGTH) return [];

    return (seriesMainSearchResults ?? []).filter((channel) => {
      if (!isChannelRecord(channel)) return false;
      const groupName = (channel.group && String(channel.group).trim()) || "Uncategorized";
      return isGroupVisible(groupName);
    });
  }, [
    isMainMoviesScreen,
    moviesMainSearchTerm,
    contentChannels,
    activeGroup,
    categoryRefreshTick,
    isMainSeriesScreen,
    filteredChannels,
    seriesMainSearchDebouncedTerm,
    seriesMainSearchResults,
    moviesSortDirection,
    favoritesRefreshTick
  ]);
  const showIdlePlayerStatus = !showOpeningScreen && !currentChannel && activePanel === null && filteredChannels.length === 0;

  function commitSeriesMainSearch(nextTerm: string) {
    setSeriesMainSearchDebouncedTerm(nextTerm);
  }

  function appendSeriesSearchDraft(fragment: string) {
    setSeriesMainSearchDraft((current) => `${current}${fragment}`.slice(0, 32));
  }

  function backspaceSeriesSearchDraft() {
    setSeriesMainSearchDraft((current) => current.slice(0, -1));
  }

  function applySeriesSearchDraft() {
    commitSeriesMainSearch(seriesMainSearchDraft);
    setIsSeriesSearchComposerOpen(false);
  }

  function exitVodPlayback() {
    stopPlayback();
    setCurrentChannel(null);
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setShowNowNext(false);
    setActivePanel(null);
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
    if (isLiveContentPage && !isGroupVisible(activeGroup) && activeGroup !== ROOT_GROUP) {
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
  }, [isSeriesPage, isPlaylistManagerSeriesMode, isSeriesPickerVisible]);

  useEffect(() => {
    if (isMainSeriesScreen) return;
    setIsSeriesSearchComposerOpen(false);
    setSeriesMainSearchDraft("");
    setSeriesMainSearchDebouncedTerm("");
  }, [isMainSeriesScreen]);

  useEffect(() => {
    if (isMainMoviesScreen) return;
    setMoviesMainSearchTerm("");
  }, [isMainMoviesScreen]);

  useEffect(() => {
    if (!isMainSeriesScreen) {
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

    const matches: any[] = [];
    for (let index = 0; index < searchableSeriesIndex.length; index += 1) {
      const entry = searchableSeriesIndex[index];
      if (entry.haystack.includes(term)) {
        matches.push(entry.channel);
        if (matches.length >= MAX_SERIES_SEARCH_RESULTS) {
          break;
        }
      }
    }

    setSeriesMainSearchResults(matches);
  }, [isMainSeriesScreen, seriesMainSearchDebouncedTerm, searchableSeriesIndex]);

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

        setPlayerStatus("Loading live channels from saved playlist…");
        const { channels: loadedChannels } = await loadFromAnyPlaylist([sharedPlaylist], "live");
        const ingested = await ingestCapacitorLiveChannelCatalogAsync(
          loadedChannels,
          pickDefaultLiveGroup(loadedChannels)
        );
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
        setChannelUpdateTick((t) => t + 1);
        setActiveGroup(ingested.groupName);
        setPlayerStatus(null);
        setTimeout(() => setActiveVisibilityRole(kind), 0);
        return true;
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
        '.nn-program, .epg-grid-title, .epg-event-title, .epg-search-guide-programme-title, .channel-icon-label, .channel-row-btn'
      );
      
      if (!programElement) return;
      
      // Don't trigger if we're on the opening screen
      if (showOpeningScreen) return;
      
      // For live TV, use the CSS-based fullscreen AND native fullscreen on video
      if (contentPage === "live") {
        setIsLiveFullscreenRequested(true);
        setShowLiveMenu(false);
        
        // Also trigger native fullscreen on the video element
        const video = document.querySelector('video');
        if (video) {
          if (video.requestFullscreen) {
            void video.requestFullscreen().catch(() => {});
          } else if ((video as any).webkitRequestFullscreen) {
            void (video as any).webkitRequestFullscreen().catch(() => {});
          }
        }
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
      const margin = 20;
      const compactWidth = window.innerWidth <= 1280 ? 560 : 720;
      const compactHeight = window.innerWidth <= 1280 ? 315 : 405;
      document.documentElement.style.setProperty("--live-preview-top", `${margin}px`);
      document.documentElement.style.setProperty("--live-preview-right", `${margin}px`);

      // Keep preview dimensions deterministic so fullscreen transitions can never
      // leak viewport-sized values back into compact preview mode.
      document.documentElement.style.setProperty("--live-preview-width", `${compactWidth}px`);
      document.documentElement.style.setProperty("--live-preview-height", `${compactHeight}px`);

      const shell = document.querySelector(".live-preview-shell") as HTMLElement | null;
      const placeholder = document.querySelector(".live-preview-placeholder") as HTMLElement | null;

      [shell, placeholder].forEach((el) => {
        if (!el) return;
        el.style.position = "fixed";
        el.style.top = `${margin}px`;
        el.style.right = `${margin}px`;
        el.style.left = "auto";
        el.style.bottom = "auto";
        el.style.transform = "none";
      });
    };

    applyPinnedPreviewPosition();
    window.addEventListener("resize", applyPinnedPreviewPosition);

    if (isCapacitorRuntime()) {
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
  }, [showOpeningScreen, contentPage, currentChannel?.id]);

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
    // Apply the correct visibility filter whenever the login level changes.
    // No login or adult login → adult visibility; child login → child visibility.
    setActiveVisibilityRole(accessLevel === "child" ? "child" : "adult");
    setCategoryRefreshTick((tick) => tick + 1);
  }, [accessLevel]);

  useEffect(() => {
    const debugLog = (window as any).webosDebugLog || console.log.bind(console);
    const security = readSetupSecurity();
    
    debugLog(`startup-check: show=${showOpeningScreen} completed=${startupCacheHydrationCompletedRef.current} login=${security.loginRequired} access=${accessLevel} inflight=${startupAutoLoadInFlightRef.current}`);

    if (!showOpeningScreen) {
      debugLog('startup: SKIP - not on opening screen');
      return;
    }

    // Fire TV: defer channel cache parse, but restore playlist IDs/metadata quickly.
    if (isCapacitorRuntime()) {
      if (startupCacheHydrationCompletedRef.current) {
        return;
      }
      debugLog("startup: Capacitor fast-boot — deferring channel cache until Live TV");
      scheduleCapacitorLegacyCachePurge();
      startupCacheHydrationCompletedRef.current = true;
      setActivePanel(null);

      const adultPlaylistId = readStoredItem(ADULT_PLAYLIST_ID_KEY);
      const childPlaylistId = readStoredItem(CHILD_PLAYLIST_ID_KEY);
      const sharedPlaylistId = readStoredItem(SHARED_PLAYLIST_ID_KEY);
      const preferredPlaylistId = sharedPlaylistId || adultPlaylistId || childPlaylistId;
      if (preferredPlaylistId) {
        setActivePlaylistId(preferredPlaylistId);
      }

      window.setTimeout(() => {
        const playlists = loadPlaylists();
        debugLog(`startup: Capacitor deferred playlists=${playlists.length} adultId=${adultPlaylistId || "none"}`);
        setHasPlaylists(playlists.length > 0);
        if (!preferredPlaylistId && playlists[0]?.id) {
          setActivePlaylistId(playlists[0].id);
        }
      }, 400);

      return;
    }

    if (startupCacheHydrationCompletedRef.current) {
      debugLog('startup: SKIP - already completed');
      return;
    }
    if (security.loginRequired && !accessLevel) {
      debugLog('startup: SKIP - waiting for login');
      // Pre-warm the channel cache in the background so role login is instant.
      void restoreChannelsCache();
      return;
    }
    if (accessLevel === "adult" || accessLevel === "child") {
      debugLog('startup: SKIP - has access level');
      return;
    }
    if (startupAutoLoadInFlightRef.current) {
      debugLog('startup: SKIP - already in flight');
      return;
    }

    const playlists = loadPlaylists();
    const playlistsHydrationPending = isPlaylistsHydrationPending();
    
    debugLog(`startup: playlists=${playlists.length} hydrationPending=${playlistsHydrationPending}`);

    // IndexedDB hydration may populate playlists shortly after startup.
    // Wait for hydration events instead of finalizing an empty auto-load path.
    if (playlists.length === 0 && playlistsHydrationPending) {
      debugLog('startup: SKIP - waiting for playlist hydration');
      return;
    }

    // If channels are already in memory from a same-session load, keep the
    // opening menu visible and align shared playlist state.
    if (getAllChannels().length > 0) {
      debugLog('startup: using existing in-memory channels');
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

    debugLog('startup: PROCEEDING with cache load');
    let cancelled = false;
    startupAutoLoadInFlightRef.current = true;

    (async () => {
      const debugLog = (window as any).webosDebugLog || console.log.bind(console);
      debugLog('startup: restoring cache...');
      
      // 1. Try restoring from local cache for an instant start, but do not
      // block startup for a long time on slow IndexedDB/storage reads.
      const restored = await restoreChannelsCache();
      debugLog(`startup: restored ${restored.length} channels`);
      if (cancelled) return;

      function applyPreparedContent(channelList: any[], playlistId: string, visibilityRole?: "adult" | "child") {
        debugLog(`startup: applying ${channelList.length} channels`);
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
        applyPreparedContent(restored, storedPlaylistId, "adult");
        setChannelUpdateTick((tick) => tick + 1);
        setCategoryRefreshTick((tick) => tick + 1);
        debugLog('startup: cache applied successfully');
        return;
      }

      debugLog('startup: no cache found, staying on menu');
      // Keep startup local. An explicit content action can fetch a saved playlist
      // when no channel cache exists, then persist it for future launches.
      startupCacheHydrationCompletedRef.current = true;
      setActivePanel(null);
      setShowOpeningScreen(true);

      // On webOS the TV may have purged every cache layer while the playlists
      // survived (DB8). Fetch live channels in the background so content is
      // ready by the time the user leaves the menu — "loads by itself".
      if (isWebOsRuntime()) {
        const savedPlaylists = loadPlaylists();
        if (savedPlaylists.length > 0) {
          debugLog('startup: auto-fetching live channels from saved playlist');
          // Register on the shared auto-load token so any manual load (menu,
          // playlist manager) supersedes this background fetch immediately.
          const requestToken = autoLoadTokenRef.current + 1;
          autoLoadTokenRef.current = requestToken;
          const preferredId = (readStoredItem(SHARED_PLAYLIST_ID_KEY) || savedPlaylists[0]?.id || "").trim();
          const orderedPlaylists = [
            ...savedPlaylists.filter((playlist) => String(playlist.id) === preferredId),
            ...savedPlaylists.filter((playlist) => String(playlist.id) !== preferredId)
          ];

          for (const playlist of orderedPlaylists) {
            if (cancelled || autoLoadTokenRef.current !== requestToken) return;
            try {
              const liveChannels = await loadChannelsForPlaylist(playlist, "live");
              if (cancelled || autoLoadTokenRef.current !== requestToken) return;
              if (!Array.isArray(liveChannels) || liveChannels.length === 0) continue;

              setActivePlaylistId(playlist.id);
              writeStoredItem(SHARED_PLAYLIST_ID_KEY, playlist.id);
              setChannels(liveChannels as any[], "startup-auto-fetch");
              setChannelUpdateTick((tick) => tick + 1);
              setCategoryRefreshTick((tick) => tick + 1);
              debugLog(`startup: auto-fetched ${liveChannels.length} live channels`);

              // Continue with the VOD catalogs in the background so Movies and
              // Series open instantly instead of fetching on first entry.
              // Delayed to let the UI settle; aborts if a manual load starts.
              window.setTimeout(() => {
                void (async () => {
                  for (const scope of ["movies", "series"] as const) {
                    if (cancelled || autoLoadTokenRef.current !== requestToken) return;
                    try {
                      const scopedChannels = await loadChannelsForPlaylist(playlist, scope);
                      if (cancelled || autoLoadTokenRef.current !== requestToken) return;
                      if (!Array.isArray(scopedChannels) || scopedChannels.length === 0) continue;

                      const byId = new Map<string, any>();
                      getAllChannels().forEach((channel) => byId.set(String(channel?.id || ""), channel));
                      scopedChannels.forEach((channel) => byId.set(String(channel?.id || ""), channel));
                      setChannels(Array.from(byId.values()) as any[], "startup-auto-fetch");
                      setChannelUpdateTick((tick) => tick + 1);
                      setCategoryRefreshTick((tick) => tick + 1);
                      debugLog(`startup: prefetched ${scopedChannels.length} ${scope}`);
                    } catch {
                      // Skip this scope; the lazy loader still covers it on entry.
                    }
                  }
                })();
              }, 4000);
              return;
            } catch {
              // Try the next saved playlist.
            }
          }
          debugLog('startup: auto-fetch got no live channels');
        }
      }
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
        for (const playlist of playlists) {
          try {
            await loadEPGForPlaylist(playlist, { forceRefresh: true });
          } catch {
            // Keep refresh resilient if guide endpoints are temporarily unavailable.
          }
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
      if (!isChannelVisible(channelId) || !isGroupVisible(groupName)) {
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
    const onPlayerError = (e: Event) => {
      if (suppressPlayerEventsRef.current) return;
      if (!currentChannelRef.current) return;

      const custom = e as CustomEvent<{ message?: string }>;
      const message = custom.detail?.message || "Playback failed for this stream.";
      setPlayerStatus(null);
      setPlayerWarning(null);
      setPlayerError(message);
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
    const onPlayerEnded = () => {
      if (suppressPlayerEventsRef.current) return;

      const activeChannel = currentChannelRef.current;
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
        let candidates = Array.isArray(seriesPickerEpisodes) ? seriesPickerEpisodes : [];
        let nextEpisode = findNextSeriesEpisode(activeChannel, candidates);

        if (!nextEpisode) {
          try {
            candidates = await loadXtreamSeriesEpisodesFromChannel(activeChannel);
          } catch {
            candidates = [];
          }

          if (token !== seriesAutoAdvanceTokenRef.current) return;

          const currentUrl = String(currentChannelRef.current?.url || "");
          if (!currentUrl || currentUrl !== activeUrl) return;

          nextEpisode = findNextSeriesEpisode(activeChannel, candidates);
        }

        if (!nextEpisode) return;

        rememberSeriesEpisode(activeChannel, nextEpisode);
        playChannel(nextEpisode);
      };

      void continueToNextEpisode();
    };

    window.addEventListener("playerEnded", onPlayerEnded);
    return () => {
      window.removeEventListener("playerEnded", onPlayerEnded);
    };
  }, [seriesPickerEpisodes]);

  useEffect(() => {
    // Helper to handle Back navigation (shared by webosBackKey and keydown)
    const handleBackNavigation = () => {
      const debugLog = (window as any).webosDebugLog;
      
      // Handle Back navigation
      if (isSeriesPickerVisible) {
        setIsSeriesPickerVisible(false);
        return true;
      }

      if (isVodPlaybackFullscreen) {
        exitVodPlayback();
        return true;
      }

      if (contentPage === "live" && isEffectiveLiveFullscreen) {
        setIsLiveFullscreenRequested(false);
        setShowLiveMenu(true);
        return true;
      }

      if (showOpeningScreen && !activePanel) {
        // On main menu - Back should exit the app
        const isWebOS = /Web0S|NetCast/i.test(navigator.userAgent || "") && !/Android/i.test(navigator.userAgent || "");
        const isCap = !!(window as any).Capacitor || window.location.hostname === "app";

        if (isWebOS) {

          if (debugLog) debugLog(`APP: Back -> exit app (webOS)`);
          try {
            if ((window as any).webOS?.platformBack) {
              (window as any).webOS.platformBack();
            } else {
              window.close();
            }
          } catch (e) {
            if (debugLog) debugLog(`APP: exit failed: ${e}`);
          }
        } else if (isCap) {
          if (debugLog) debugLog(`APP: Back -> exit app (Capacitor)`);
          try {
            // Use the Capacitor global to access plugins
            const AppPlugin = (window as any).Capacitor?.Plugins?.App;
            if (AppPlugin && typeof AppPlugin.exitApp === "function") {
              void AppPlugin.exitApp();
            } else {
              window.close();
            }
          } catch (e) {
            window.close();
          }
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
          setShowOpeningScreen(true);
        }
        return true;
      } else {
        if (currentChannel && contentPage === "live") {
          exitLivePlaybackToBrowser();
        } else if (currentChannel && (contentPage === "movies" || contentPage === "series" || contentPage === "playlistManager")) {
          stopCurrentVodPlaybackIfNeeded();
          setCurrentChannel(null);
          setShowOpeningScreen(true);
        } else {
          setShowOpeningScreen(true);
        }
        return true;
      }
    };

    // Listen for custom webosBackKey event (dispatched by webOS SDK)
    const handleWebosBack = () => {
      const debugLog = (window as any).webosDebugLog;
      if (debugLog) debugLog(`APP: webosBackKey event received`);
      handleBackNavigation();
    };
    
    window.addEventListener('webosBackKey', handleWebosBack);
    
    // Regular keydown handler
    const onKeyDown = (e: KeyboardEvent) => {
      const debugLog = (window as any).webosDebugLog;
      
      // Log every keydown that reaches this handler
      if (debugLog) {
        debugLog(`APP-HANDLER: key=${e.key} code=${e.keyCode}`);
      }
      
      const isBack = isBackKeyEvent(e);
      
      // On webOS, Back is handled by webOS SDK + webosBackKey event
      // On other platforms, handle Back here directly
      const isWebOS = (window as any).webOS?.libVersion;
      
      if (isBack) {
        if (isWebOS) {
          // webOS SDK will dispatch webosBackKey event
          return;
        }
        // Non-webOS: handle Back directly
        e.preventDefault();
        handleBackNavigation();
        return;
      }
      
      if (isTextEntryTarget(e.target)) return;

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
      window.removeEventListener('webosBackKey', handleWebosBack);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [activePanel, isVodPlaybackFullscreen, currentChannel, isSeriesPickerVisible, contentPage, isEffectiveLiveFullscreen, showOpeningScreen, hasPlaylists]);

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
    const tileCheckboxFor = (btn: HTMLElement | null): HTMLInputElement | null => {
      const cb = btn?.closest(".channel-icon-wrap")?.querySelector<HTMLInputElement>('.channel-icon-toggle input[type="checkbox"]');
      return cb && !cb.disabled ? cb : null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e.target)) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl) return;

      const key = normalizeRemoteNavKey(e);
      const isOverlayCheckbox =
        activeEl instanceof HTMLInputElement &&
        activeEl.type === "checkbox" &&
        !!activeEl.closest(".channel-icon-toggle");

      // Remote OK sends Enter; native checkboxes only toggle on Space.
      if (key === "Enter") {
        if (isOverlayCheckbox) {
          e.preventDefault();
          activeEl.click();
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;

      const inIconGrid = !!activeEl.closest(".channel-list-icons");
      const inModeButtons = !!activeEl.closest(".playlist-manager-actions");
      if (!inIconGrid && !inModeButtons) return;

      const movieButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".channel-list-icons .channel-icon-btn")
      );
      const modeButtons = inModeButtons || (inIconGrid && key === "ArrowUp")
        ? Array.from(document.querySelectorAll<HTMLButtonElement>(".playlist-manager-actions button"))
        : [];

      if (movieButtons.length === 0) return;

      // An overlay checkbox occupies the same grid position as its poster.
      const tileButton = isOverlayCheckbox
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

      if (movieIndex >= 0) {
        if (key === "ArrowUp") {
          e.preventDefault();
          // Overlay checkbox first (playlist manager), then the row above.
          const cb = tileCheckboxFor(tileButton);
          if (cb) {
            cb.focus();
            return;
          }
          if (movieIndex < columns) {
            (modeButtons[1] || modeButtons[0])?.focus();
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
          if (movieIndex > 0) {
            e.preventDefault();
            focusTile(movieIndex - 1);
          }
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
  }, [isContentIconsView, filteredChannels.length]);

  useEffect(() => {
    // Remote arrow-key navigation for the list views (live TV page and
    // playlist manager in TV mode). These screens were pointer-only, which
    // strands TV remotes: arrows move focus through the group column, the
    // channel column, and per-row visibility checkboxes.
    const remoteListNavActive =
      !showOpeningScreen &&
      activePanel === null &&
      (contentPage === "live" || (contentPage === "playlistManager" && contentMode === "tv"));
    if (!remoteListNavActive) return;

    const enabledButton = (row: HTMLElement | null): HTMLButtonElement | null => {
      if (!row) return null;
      if (row instanceof HTMLButtonElement) return row.disabled ? null : row;
      const btn = row.querySelector<HTMLButtonElement>("button");
      return btn && !btn.disabled ? btn : null;
    };

    const enabledCheckbox = (row: HTMLElement | null): HTMLInputElement | null => {
      if (!row || row instanceof HTMLButtonElement) return null;
      const cb = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      return cb && !cb.disabled ? cb : null;
    };

    const rowStop = (row: HTMLElement | null): HTMLElement | null =>
      enabledButton(row) || enabledCheckbox(row);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntryTarget(e.target)) return;

      const active = document.activeElement as HTMLElement | null;
      const key = normalizeRemoteNavKey(e);

      // Remote OK sends Enter; native checkboxes only toggle on Space.
      if (key === "Enter") {
        if (active instanceof HTMLInputElement && active.type === "checkbox") {
          e.preventDefault();
          active.click();
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) return;

      const groupRows = Array.from(document.querySelectorAll<HTMLElement>(".group-list .group-item"));
      const channelRows = Array.from(document.querySelectorAll<HTMLElement>(".channel-list .channel-item"))
        .filter((row) => !row.classList.contains("channel-header-item"));
      const toolbarButtons = Array.from(
        document.querySelectorAll<HTMLElement>(".group-list .group-list-bulk-btn")
      );
      const loadMoreBtn = document.querySelector<HTMLElement>(".channel-list .channel-load-more-btn");
      if (groupRows.length === 0 && channelRows.length === 0) return;

      const isCheckbox = active instanceof HTMLInputElement && active.type === "checkbox";
      const findRowIndex = (rows: HTMLElement[]) =>
        rows.findIndex((row) => row === active || (!!active && row.contains(active)));

      const toolbarIndex = active ? toolbarButtons.indexOf(active) : -1;
      const groupIndex = findRowIndex(groupRows);
      const channelIndex = findRowIndex(channelRows);
      const onLoadMore = !!active && active === loadMoreBtn;

      const currentGroupStop = () =>
        rowStop(document.querySelector<HTMLElement>(".group-list .group-item.active")) ||
        rowStop(groupRows[0] || null);

      // Keep column identity while moving vertically: checkbox stays in the
      // checkbox column, button stays in the button column.
      const verticalStop = (row: HTMLElement | null): HTMLElement | null => {
        if (!row) return null;
        if (isCheckbox) return enabledCheckbox(row) || enabledButton(row);
        return enabledButton(row) || enabledCheckbox(row);
      };

      const moveTo = (el: HTMLElement | null) => {
        e.preventDefault();
        if (el) el.focus();
      };

      // Focus is outside the lists: capture only from inert targets (body,
      // video surface), never steal from other focused buttons (EPG, player).
      if (toolbarIndex < 0 && groupIndex < 0 && channelIndex < 0 && !onLoadMore) {
        const inert =
          !active ||
          active === document.body ||
          active === document.documentElement ||
          active instanceof HTMLMediaElement;
        if (!inert) return;
        moveTo(currentGroupStop() || verticalStop(channelRows[0] || null));
        return;
      }

      if (toolbarIndex >= 0) {
        if (key === "ArrowLeft") moveTo(toolbarButtons[toolbarIndex - 1] || null);
        else if (key === "ArrowRight") moveTo(toolbarButtons[toolbarIndex + 1] || null);
        else if (key === "ArrowDown") moveTo(currentGroupStop());
        else e.preventDefault();
        return;
      }

      if (groupIndex >= 0) {
        const row = groupRows[groupIndex];
        if (key === "ArrowUp") {
          if (groupIndex === 0) moveTo(toolbarButtons[0] || null);
          else moveTo(verticalStop(groupRows[groupIndex - 1]));
        } else if (key === "ArrowDown") {
          moveTo(verticalStop(groupRows[groupIndex + 1] || null));
        } else if (key === "ArrowLeft") {
          // Row button -> its visibility checkbox (playlist manager).
          if (!isCheckbox) moveTo(enabledCheckbox(row) || null);
          else e.preventDefault();
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

      if (channelIndex >= 0) {
        const row = channelRows[channelIndex];
        if (key === "ArrowUp") {
          moveTo(verticalStop(channelRows[channelIndex - 1] || null));
        } else if (key === "ArrowDown") {
          if (channelIndex === channelRows.length - 1) moveTo(loadMoreBtn);
          else moveTo(verticalStop(channelRows[channelIndex + 1] || null));
        } else if (key === "ArrowLeft") {
          // Row button -> its checkbox first (playlist manager), then groups.
          if (!isCheckbox && enabledCheckbox(row)) moveTo(enabledCheckbox(row));
          else moveTo(currentGroupStop());
        } else {
          // Right: checkbox -> row button; button -> stay put.
          if (isCheckbox) moveTo(enabledButton(row));
          else e.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showOpeningScreen, activePanel, contentPage, contentMode]);

  function normalizePlayableChannelUrl(ch: any): string {
    const rawUrl = String(ch?.url || "");
    if (!rawUrl) return rawUrl;
    const contentType = String(ch?.contentType || "live").toLowerCase();

    // Older loaded Xtream live channels were built with a forced .m3u8 suffix.
    // Newer loaders use the provider's real extension, typically .ts.
    if (contentType === "live" && /\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(rawUrl)) {
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

  async function openSeriesEpisodePicker(seriesChannel: any) {
    setSeriesPickerTitle(String(seriesChannel?.name || "Series"));
    setSeriesPickerEpisodes([]);
    setSeriesPickerError(null);
    setSeriesPickerLoading(true);
    setSeriesPickerSourceChannel(seriesChannel);
    setIsSeriesPickerVisible(true);

    try {
      const episodes = await loadXtreamSeriesEpisodesFromChannel(seriesChannel);
      setSeriesPickerEpisodes(episodes);

      if (episodes.length === 0) {
        setSeriesPickerError("No episodes found for this series.");
      }
    } catch {
      setSeriesPickerError("Could not load episodes for this series.");
    } finally {
      setSeriesPickerLoading(false);
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

  function playChannel(ch: any) {
    if (showOpeningScreen) {
      // Ignore tune attempts until the user leaves the opening screen.
      return;
    }

    let capacitorMemoryTrimmed = false;
    if (isCapacitorRuntime() && matchesContentMode(ch, "tv")) {
      trimCapacitorChannelMemoryForLive();
      const groupName = (ch?.group && String(ch.group).trim()) || "Uncategorized";
      const beforeCount = getAllChannels().length;
      const afterCount = releaseCapacitorMemoryForLivePlayback(groupName, String(ch?.id || ""));
      capacitorMemoryTrimmed = afterCount < beforeCount;
    }

    console.log(`[playChannel] attempting to play: name=${ch?.name} url=${String(ch?.url).slice(0, 80)}...`);
    if (!ch?.url || typeof ch.url !== "string") {
      const msg = "This channel has no playable stream URL.";
      console.warn(`[playChannel] blocked: ${msg}`);
      setPlayerError(msg);
      return;
    }

    if (isTopLevelSeriesSelection(ch)) {
      void openSeriesEpisodePicker(ch);
      return;
    }

    // Guard against rapid duplicate tune events for the same stream.
    const now = Date.now();
    const requestId = ch?.id ? String(ch.id) : null;
    const requestUrl = normalizePlayableChannelUrl(ch);
    const isDuplicateRapidRequest =
      lastPlayRequestRef.current.id === requestId &&
      lastPlayRequestRef.current.url === requestUrl &&
      now - lastPlayRequestRef.current.at < 1500;

    if (isDuplicateRapidRequest) {
      return;
    }

    lastPlayRequestRef.current = {
      id: requestId,
      url: requestUrl,
      at: now
    };

    suppressPlayerEventsRef.current = false;
    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    const isLiveSelection = matchesContentMode(ch, "tv");

    setCurrentChannel(ch);
    setIsSeriesPickerVisible(false);
    setActivePanel(null);
    if (isLiveSelection) {
      setHasSelectedLiveChannel(true);
      // Fire TV: hide the channel/group lists during playback to avoid GC thrash.
      setShowLiveMenu(!isCapacitorRuntime());
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

    // Stop the previous tune immediately so ExoPlayer can switch without waiting
    // for React to re-render the HTML video surface.
    if (useNativeLivePlayback && currentChannelRef.current) {
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
    setShowNowNext(true);
    setShowOpeningScreen(false);
  }

  function togglePlayPause() {
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player) return;

    if (player.paused) {
      void player.play();
      return;
    }

    player.pause();
  }

  function toggleMute() {
    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (!player) return;

    if (player.muted || player.volume === 0) {
      player.muted = false;
      if (player.volume === 0) player.volume = 1;
      return;
    }

    player.muted = true;
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

        const keepPlaylistManagerPage = contentPage === "playlistManager";
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

    const keepPlaylistManagerPage = contentPage === "playlistManager";
    const latestChannels = getAllChannels();
    const modeChannels = latestChannels.filter((channel) => matchesContentMode(channel, content));

    if (modeChannels.length === 0) {
      // No channels for this mode yet. If we have playlists, auto-load the first
      // one (and force a content-mode preference for the user's choice) instead
      // of dropping a confusing "no channels" alert.
      if (latestChannels.length === 0) {
        const roleAccessLevel = accessLevel as "adult" | "child";
        if (roleAccessLevel === "adult" || roleAccessLevel === "child") {
          void (async () => {
            const restored = await restoreRoleContentForLogin(roleAccessLevel);
            if (!restored) {
              setLoginError(
                roleAccessLevel === "adult"
                  ? "Adult playlist is not assigned or failed to load."
                  : "Child playlist is not assigned or failed to load."
              );
              setContentPage("playlistManager");
              setActivePanel(null);
              setShowOpeningScreen(false);
              return;
            }

            const refreshedChannels = getAllChannels();
            const refreshedModeChannels = refreshedChannels.filter((channel) => matchesContentMode(channel, content));
            if (refreshedModeChannels.length === 0) {
              alert(`Assigned ${roleAccessLevel} playlist has no ${content} entries.`);
              return;
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
              setActiveGroup(ROOT_GROUP);
            } else {
              setActiveGroup(pickDefaultContentGroup(refreshedChannels, content));
            }

            await ensureGuideEPGLoaded();
          })();
          return;
        }

        const playlists = loadPlaylists();
        if (playlists.length === 0) {
          // No playlists configured — guide user to add one.
          setActivePanel("playlist");
          setShowOpeningScreen(false);
          return;
        }

        (async () => {
          const requestToken = autoLoadTokenRef.current + 1;
          autoLoadTokenRef.current = requestToken;

          try {
            const { playlist, channels } = await loadFromAnyPlaylist(playlists);
            if (requestToken !== autoLoadTokenRef.current) return;
            if (accessLevelRef.current === "adult" || accessLevelRef.current === "child") return;

            setActivePlaylistId(playlist.id);
            writeStoredItem(SHARED_PLAYLIST_ID_KEY, playlist.id);
            setChannels(channels);
            setChannelUpdateTick((t) => t + 1);
            resetVisibilityForCurrentChannels();
            setCategoryRefreshTick((tick) => tick + 1);

            const refreshed = channels.filter((channel: any) => matchesContentMode(channel, content));
            if (refreshed.length === 0) {
              alert(`Playlist "${playlist.name}" has no ${content} entries.`);
              return;
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
              setActiveGroup(ROOT_GROUP);
            } else {
              setActiveGroup(pickDefaultContentGroup(refreshed, content));
            }

            await loadEPGForPlaylist(playlist).catch(() => {
              // EPG is optional; ignore failures here.
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            alert(`Failed to load playlist: ${message}`);
          }
        })();
        return;
      }

      // Channels are already loaded, but not for this mode yet. Lazily load
      // the requested scope from the current/saved playlist and merge.
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

        for (const playlist of orderedPlaylists) {
          try {
            const scopedChannels = await loadChannelsForPlaylist(playlist, scope);
            if (requestToken !== autoLoadTokenRef.current) return;
            if (!Array.isArray(scopedChannels) || scopedChannels.length === 0) continue;

            const byId = new Map<string, any>();
            latestChannels.forEach((channel) => byId.set(String(channel?.id || ""), channel));
            scopedChannels.forEach((channel) => byId.set(String(channel?.id || ""), channel));
            let mergedChannels = Array.from(byId.values()).filter((channel) => isChannelRecord(channel));

            if (isCapacitorRuntime() && mergedChannels.length > 15000) {
              mergedChannels = scopedChannels.filter((channel) => isChannelRecord(channel));
            }

            setActivePlaylistId(playlist.id);
            writeStoredItem(SHARED_PLAYLIST_ID_KEY, playlist.id);
            setChannels(mergedChannels as any[], `lazy-${scope}-load`);
            setChannelUpdateTick((tick) => tick + 1);
            setCategoryRefreshTick((tick) => tick + 1);

            const refreshedModeChannels = mergedChannels.filter((channel) => matchesContentMode(channel, content));
            if (refreshedModeChannels.length === 0) continue;

            setShowOpeningScreen(false);
            setActivePanel(null);
            setContentMode(content);

            if (!keepPlaylistManagerPage) {
              if (content === "tv") setContentPage("live");
              if (content === "movies") setContentPage("movies");
              if (content === "series") setContentPage("series");
            }

            if (content === "tv") {
              setActiveGroup(pickDefaultLiveGroup(mergedChannels));
              await loadEPGForPlaylist(playlist).catch(() => {});
            } else {
              setActiveGroup(pickDefaultContentGroup(mergedChannels, content));
            }

            return;
          } catch {
            // Try the next playlist candidate.
          }
        }

        alert(`No ${content} entries found in the loaded playlist.`);
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
    resetVisibilityForCurrentChannels();
    const preferredMode = pickPreferredContentMode(channels);
    const keepPlaylistManagerPage = contentPage === "playlistManager";

    // PlaylistManager writes channels directly to the shared store; bump the
    // local tick so App recomputes memoized channel/group views immediately.
    setChannelUpdateTick((tick) => tick + 1);
    setContentMode(preferredMode);
    if (!keepPlaylistManagerPage) {
      setContentPage(preferredMode === "tv" ? "live" : preferredMode);
    }
    setActiveGroup(pickDefaultContentGroup(channels, preferredMode));
    setShowOpeningScreen(false);
    setActivePanel(null);
    setCategoryRefreshTick((tick) => tick + 1);
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

    guidePrefetchInFlightRef.current = true;
    let updated = 0;
    const workerCount = Math.min(10, candidates.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < candidates.length) {
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
      setCategoryRefreshTick((tick) => tick + 1);
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

    if (liveChannels.length === 0) {
      const playlists = loadPlaylists();
      const preferredPlaylistId = (
        activePlaylistId ||
        readStoredItem(SHARED_PLAYLIST_ID_KEY) ||
        readStoredItem(ADULT_PLAYLIST_ID_KEY) ||
        playlists[0]?.id ||
        ""
      ).trim();
      const targetPlaylist =
        (preferredPlaylistId && playlists.find((playlist) => String(playlist.id) === preferredPlaylistId)) ||
        playlists[0];

      if (playlists.length > 0) {
        setPlayerStatus("Loading live channels from saved playlist…");
        const orderedPlaylists = targetPlaylist
          ? [targetPlaylist, ...playlists.filter((playlist) => playlist.id !== targetPlaylist.id)]
          : playlists;

        try {
          const { playlist: resolvedPlaylist, channels: loadedChannels } = await loadFromAnyPlaylist(
            orderedPlaylists,
            "live"
          );
          liveChannels = loadedChannels.filter((channel) => matchesContentMode(channel, "tv"));
          if (liveChannels.length > 0) {
            if (isCapacitorRuntime()) {
              const ingested = await ingestCapacitorLiveChannelCatalogAsync(
                loadedChannels,
                pickDefaultLiveGroup(liveChannels)
              );
              liveChannels = getAllChannels().filter((channel) => matchesContentMode(channel, "tv"));
              writeStoredItem(SHARED_PLAYLIST_ID_KEY, resolvedPlaylist.id);
              setActivePlaylistId(resolvedPlaylist.id);
              resetVisibilityForCurrentChannels();
              setCategoryRefreshTick((tick) => tick + 1);
              setChannelUpdateTick((tick) => tick + 1);
              setPlayerStatus(null);
              openLiveView(liveChannels);
              setActiveGroup(ingested.groupName);
              void loadEPGForPlaylist(resolvedPlaylist).catch(() => {});
              return;
            }

            setChannels(loadedChannels, "start-live-load");
            setChannelUpdateTick((tick) => tick + 1);
            writeStoredItem(SHARED_PLAYLIST_ID_KEY, resolvedPlaylist.id);
            setActivePlaylistId(resolvedPlaylist.id);
            resetVisibilityForCurrentChannels();
            setCategoryRefreshTick((tick) => tick + 1);
            void loadEPGForPlaylist(resolvedPlaylist).catch(() => {});
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setLoginError(`Saved playlists failed to load: ${message}`);
          setPlayerStatus(null);
          setActivePanel(null);
          setShowOpeningScreen(false);
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

    setLoginError("No saved Live TV channels are available. Open Playlist Manager and choose Reload.");
    setContentPage("playlistManager");
    setActivePanel(null);
    setShowOpeningScreen(false);
    setPlayerStatus(null);
  }

  return (
    <div className="app-root">
      {shouldRenderMainVideo && useLivePreviewShell && (
        <div className={`live-preview-shell${isLivePreviewFullscreen ? " live-preview-shell-fullscreen" : ""}`} aria-hidden="false">
            <video
              id="player-main"
              className={`player-main player-main-shell-video${currentChannel ? " player-main-native-controls" : ""}`}
              autoPlay
              playsInline
              controls={!!currentChannel}
              disablePictureInPicture={true}
              disableRemotePlayback={true}
              tabIndex={0}
              style={{ background: 'transparent', zIndex: 0 }}
            />




        </div>
      )}
      {shouldRenderMainVideo && !useLivePreviewShell && (
        <video
          id="player-main"
          className={`player-main ${shouldShowOpeningMenu && !currentChannel ? "player-main-idle" : showContentPreviewWindow ? "player-main-preview" : contentPage === "live" ? (isEffectiveLiveFullscreen ? "player-main-live" : "player-main-compact") : currentChannel ? "player-main-live" : "player-main-compact"}${forceLivePreviewLayout ? " player-main-force-preview" : ""}`}
          autoPlay
          playsInline
          controls={!!currentChannel && !forceLivePreviewLayout}
          disablePictureInPicture={contentPage === "live"}
          disableRemotePlayback={contentPage === "live"}
          tabIndex={0}
          style={{ background: 'transparent', zIndex: 0 }}
        />




      )}
      {forceLivePreviewLayout && !isPlaylistInputPanelOpen && (
        <div className="live-preview-placeholder" aria-hidden="true">
          <div className="live-preview-placeholder-title">Live TV Preview</div>
          <div className="live-preview-placeholder-subtitle">Select a channel to start playback</div>
        </div>
      )}
      {showContentPreviewWindow && (
        <div className="player-preview-badge" aria-hidden="true">Preview</div>
      )}
      {showIdlePlayerStatus && (
        <div className="player-status">
          {allChannels.length > 0 ? "No channels available in this view." : "Add a playlist to load channels."}
        </div>
      )}
      {currentChannel && playerStatus && <div className="player-status player-status-info">{playerStatus}</div>}
      {currentChannel && !playerStatus && playerWarning && <div className="player-status player-status-info">{playerWarning}</div>}
      {currentChannel && playerError && <div className="player-status player-status-error">{playerError}</div>}
      {isVodPlaybackFullscreen && (
        <button
          type="button"
          className="vod-exit-btn"
          onClick={exitVodPlayback}
          aria-label="Exit movie playback"
        >
          Back
        </button>
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

      {!shouldShowOpeningMenu && !isVodPlaybackFullscreen && (!isLiveChannelPlaying || showLiveMenu) && (
        <>
          {isMainSeriesScreen && (
            <div className="series-main-search-bar">
              <button
                type="button"
                className="series-main-search-btn"
                onClick={() => {
                  setSeriesMainSearchDraft(seriesMainSearchDebouncedTerm);
                  setIsSeriesSearchComposerOpen((open) => !open);
                }}
              >
                {seriesMainSearchDebouncedTerm.trim() ? "Change Search" : "Search"}
              </button>
              {seriesMainSearchDebouncedTerm.trim() && (
                <>
                  <button
                    type="button"
                    className="series-main-search-btn"
                    onClick={() => commitSeriesMainSearch("")}
                  >
                    Clear
                  </button>
                  <span className="series-main-search-hint" aria-live="polite">
                    Search: {seriesMainSearchDebouncedTerm.trim()}
                  </span>
                </>
              )}
              {isSeriesSearchComposerOpen && (
                <div className="series-search-composer" role="dialog" aria-label="Series search composer">
                  <div className="series-search-composer-value">
                    {seriesMainSearchDraft || "Choose characters"}
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
                      onClick={() => setSeriesMainSearchDraft("")}
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
                    Build the term with buttons, then choose Apply
                  </span>
                </div>
              )}
            </div>
          )}
          {isMainMoviesScreen && (
            <div className="movies-main-search-bar">
              <input
                type="search"
                className="movies-main-search-input"
                value={moviesMainSearchTerm}
                onChange={(event) => setMoviesMainSearchTerm(event.target.value.slice(0, 64))}
                placeholder="Search movies"
                aria-label="Search movies"
              />
              {moviesMainSearchTerm.trim() && (
                <button
                  type="button"
                  className="series-main-search-btn"
                  onClick={() => setMoviesMainSearchTerm("")}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="series-main-search-btn"
                onClick={() => setMoviesSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
                aria-label={moviesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
              >
                {moviesSortDirection === "asc" ? "Sort Z-A" : "Sort A-Z"}
              </button>
            </div>
          )}
          <GroupList
            groups={groupsForList}
            groupCounts={groupCounts}
            activeGroup={activeGroup}
            onSelect={(group) => {
              setActiveGroup(group);
            }}
            isGroupVisible={isGroupVisible}
            onToggleGroupVisible={(group, visible) => {
              setGroupVisible(group, visible);
              setCategoryRefreshTick((tick) => tick + 1);
            }}
            showVisibilityControls={isPlaylistManagerPage}
            className={isMainMoviesScreen ? "group-list-movies-right" : ""}
            batchSize={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage) ? 60 : undefined}
            autoLoadOnScroll={isCapacitorRuntime() && (isLiveContentPage || isPlaylistManagerPage)}
            onSetAllVisible={
              isPlaylistManagerPage
                ? (visible) => {
                    setGroupsVisible(groups, visible);
                    if (!visible) {
                      setActiveGroup(ROOT_GROUP);
                    }
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
            onToggleFavorite={(channel) => {
              setChannelFavoriteRecord(channel, !isFavoriteChannelRecord(channel));
            }}
            showVisibilityControls={isPlaylistManagerPage && contentMode === "tv"}
            showFavoriteControls={isContentIconsView}
            showAsIcons={isContentIconsView}
            batchSize={
              isCapacitorRuntime() && isLiveContentPage
                ? 40
                : isMainSeriesScreen && isContentIconsView
                  ? 16
                  : isMainMoviesScreen && isContentIconsView
                    ? 32
                    : undefined
            }
            suppressLogos={false}
            autoLoadOnScroll={
              (isCapacitorRuntime() && isLiveContentPage) ||
              ((isMainSeriesScreen || isMainMoviesScreen) && isContentIconsView)
            }
            listClassName={
              isMainSeriesScreen && isContentIconsView
                ? "channel-list-series-grid"
                : isMainMoviesScreen && isContentIconsView
                  ? "channel-list-movies-grid"
                  : ""
            }
          />
        </>
      )}

      {!shouldShowOpeningMenu && !isEpgSearchPanelOpen && currentChannel && (String(currentChannel.contentType || "").toLowerCase() === "live" || (!currentChannel.contentType && contentPage === "live")) && (
        <>
          <EPGGrid
            currentChannel={currentChannel}
            className={useLivePreviewShell && !isLivePreviewFullscreen ? "epg-grid-preview-window" : ""}
            onOpenGuide={() => {
              void openGuidePanel("epgSearch");
            }}
          />
          <button
            type="button"
            className={`epg-favorite-btn${useLivePreviewShell && !isLivePreviewFullscreen ? " epg-favorite-btn-preview" : ""}`}
            onClick={() => {
              if (!currentChannel) return;
              const nextFavorite = !isFavoriteChannelRecord(currentChannel);
              setChannelFavoriteRecord(currentChannel, nextFavorite);
            }}
          >
            {isFavoriteChannelRecord(currentChannel) ? "Remove Favorite" : "Add Favorite"}
          </button>
        </>
      )}
      {!shouldShowOpeningMenu && (
        <SeriesEpisodePicker
          visible={isSeriesPickerVisible}
          seriesTitle={seriesPickerTitle}
          episodes={seriesPickerEpisodes}
          loading={seriesPickerLoading}
          error={seriesPickerError}
          onClose={() => setIsSeriesPickerVisible(false)}
          favoriteLabel={
            isFavoriteChannelRecord(seriesPickerSourceChannel)
              ? "Remove Favorite"
              : "Add Favorite"
          }
          onToggleFavorite={() => {
            if (!seriesPickerSourceChannel) return;
            setChannelFavoriteRecord(seriesPickerSourceChannel, !isFavoriteChannelRecord(seriesPickerSourceChannel));
          }}
          onSelectEpisode={(episode) => {
            rememberSeriesEpisode(seriesPickerSourceChannel, episode);
            setIsSeriesPickerVisible(false);
            playChannel(episode);
          }}
        />
      )}
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

function pickPreferredContentMode(channels: any[]): "tv" | "movies" | "series" {
  if (channels.some((channel) => matchesContentMode(channel, "tv"))) {
    return "tv";
  }

  if (channels.some((channel) => matchesContentMode(channel, "movies"))) {
    return "movies";
  }

  if (channels.some((channel) => matchesContentMode(channel, "series"))) {
    return "series";
  }

  return "tv";
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
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
