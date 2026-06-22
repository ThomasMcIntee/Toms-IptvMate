/* @refresh reload */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChannelList } from "./ui/ChannelList";
import { EPGGrid } from "./ui/EPGGrid";
import { PlayerOSD } from "./ui/PlayerOSD";
import { PanelsHost } from "./ui/PanelsHost";
import { useProfile } from "./profiles/ProfileContext";
import { initNavigation } from "./core/navigation";
import { initPlayerEngine, playUrl } from "./core/playerEngine";
import { GroupList } from "./ui/GroupList";
import {
  getAllChannels,
  getGroups,
  isChannelVisible,
  isGroupVisible,
  setChannelVisible,
  setChannels,
  setGroupVisible
} from "./core/channelStore";
import NowNextOverlay from "./ui/NowNextOverlay";
import { loadPlaylists } from "./core/playlistStore";
import { loadEPGForPlaylist } from "./core/loaders/epgLoader";
import MainMenuScreen from "./ui/MainMenuScreen";
import { loadFromAnyPlaylist } from "./core/loaders/playlistLoader";

export function App() {
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
  const [activeGroup, setActiveGroup] = useState("All");
  const [contentMode, setContentMode] = useState<"tv" | "movies" | "series">("tv");
  const hasPlaylists = loadPlaylists().length > 0;
  const isLiveTvView = !showOpeningScreen && contentPage === "live" && activePanel === null;
  const isMoviesPage = !showOpeningScreen && contentPage === "movies";
  const isSeriesPage = !showOpeningScreen && contentPage === "series";
  const isPlaylistManagerPage = !showOpeningScreen && contentPage === "playlistManager";
  const isPlaylistManagerMoviesMode = isPlaylistManagerPage && contentMode === "movies";
  const isPlaylistManagerSeriesMode = isPlaylistManagerPage && contentMode === "series";
  const isContentIconsView = isMoviesPage || isSeriesPage || isPlaylistManagerMoviesMode || isPlaylistManagerSeriesMode;
  const isMovieOrSeriesSelected =
    !!currentChannel &&
    (matchesContentMode(currentChannel, "movies") || matchesContentMode(currentChannel, "series"));
  const showContentPreviewWindow =
    !showOpeningScreen &&
    isMovieOrSeriesSelected &&
    (isMoviesPage || isSeriesPage || isPlaylistManagerMoviesMode || isPlaylistManagerSeriesMode);
  const currentChannelRef = useRef<any | null>(null);
  const lastPlayRequestRef = useRef<{ id: string | null; url: string | null; at: number }>({
    id: null,
    url: null,
    at: 0
  });

  const allChannels = useMemo(() => getAllChannels(), [categoryRefreshTick, currentChannel]);
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
    const groupSet = new Set<string>(["All"]);
    contentChannels.forEach((channel) => {
      const groupName = channel.group || "Uncategorized";
      groupSet.add(groupName);
    });
    return Array.from(groupSet);
  }, [contentChannels]);
  const visibleGroups = useMemo(() => {
    return groups.filter((group) => isGroupVisible(group));
  }, [groups, categoryRefreshTick]);
  const visibleChannels = useMemo(() => {
    return contentChannels.filter((c) => {
      const groupName = c.group || "Uncategorized";
      return isGroupVisible(groupName) && isChannelVisible(c.id);
    });
  }, [contentChannels, categoryRefreshTick]);
  const groupsForList = useMemo(() => {
    return isLiveTvView ? visibleGroups : groups;
  }, [isLiveTvView, visibleGroups, groups]);
  const channelsForScope = useMemo(() => {
    return isLiveTvView ? visibleChannels : contentChannels;
  }, [isLiveTvView, visibleChannels, contentChannels]);
  const filteredChannels = useMemo(() => {
    if (activeGroup === "All") return channelsForScope;
    return channelsForScope.filter((c) => c.group === activeGroup);
  }, [channelsForScope, activeGroup]);

  useEffect(() => {
    if (!groupsForList.includes(activeGroup)) {
      setActiveGroup(groupsForList[0] || "All");
    }
  }, [groupsForList, activeGroup]);

  useEffect(() => {
    if (isLiveTvView && !isGroupVisible(activeGroup) && activeGroup !== "All") {
      setActiveGroup("All");
    }
  }, [isLiveTvView, activeGroup, categoryRefreshTick]);

  useEffect(() => {
    initPlayerEngine();
    initNavigation((panel) => {
      if (panel === "vod") {
        setContentPage("movies");
        setContentMode("movies");
        setShowOpeningScreen(false);
        setActivePanel(null);
        setActiveGroup("All");
        return;
      }

      if (panel === "series") {
        setContentPage("series");
        setContentMode("series");
        setShowOpeningScreen(false);
        setActivePanel(null);
        setActiveGroup("All");
        return;
      }

      if (panel === "playlistManager") {
        setContentPage("playlistManager");
        setShowOpeningScreen(false);
        setActivePanel(null);
        return;
      }

      setActivePanel(panel);
    });
  }, []);

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
    // Re-bind to the current video element after major UI mode changes.
    initPlayerEngine();
  }, [showOpeningScreen, activePanel]);

  useEffect(() => {
    const interval = setInterval(() => {
      const event = new CustomEvent("refreshEPG");
      window.dispatchEvent(event);
    }, 6 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handler = () => setShowNowNext(true);
    window.addEventListener("showNowNext", handler);
    return () => window.removeEventListener("showNowNext", handler);
  }, []);

  useEffect(() => {
    const refresh = () => {
      const firstPlaylist = loadPlaylists()[0];
      if (firstPlaylist) {
        void loadEPGForPlaylist(firstPlaylist);
      }
    };

    window.addEventListener("refreshEPG", refresh);
    return () => window.removeEventListener("refreshEPG", refresh);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<any>;
      playChannel(custom.detail);
    };

    window.addEventListener("tuneChannel", handler);
    return () => window.removeEventListener("tuneChannel", handler);
  }, []);

  useEffect(() => {
    currentChannelRef.current = currentChannel;
  }, [currentChannel]);

  useEffect(() => {
    const onPlayerError = (e: Event) => {
      if (!currentChannelRef.current) return;

      const custom = e as CustomEvent<{ message?: string }>;
      const message = custom.detail?.message || "Playback failed for this stream.";
      setPlayerStatus(null);
      setPlayerWarning(null);
      setPlayerError(message);
    };

    const onPlayerPlaying = () => {
      // Keep UI in live-view state whenever playback is confirmed.
      setShowOpeningScreen(false);
      setActivePanel(null);
      setPlayerError(null);

      if (playerStatus && /picture-only|video-only/i.test(playerStatus)) {
        setPlayerWarning(playerStatus);
      }

      setPlayerStatus(null);
    };

    const onPlayerTranscoding = (e: Event) => {
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
  }, [playerStatus]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowOpeningScreen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

    const onKeyDown = (e: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;

      const movieButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".channel-list-icons .channel-icon-btn")
      );
      const modeButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".playlist-manager-actions button")
      );

      if (movieButtons.length === 0) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const movieIndex = activeEl ? movieButtons.indexOf(activeEl as HTMLButtonElement) : -1;
      const modeIndex = activeEl ? modeButtons.indexOf(activeEl as HTMLButtonElement) : -1;

      const firstButtonRect = movieButtons[0]?.getBoundingClientRect();
      const listRect = movieButtons[0]?.closest(".channel-list")?.getBoundingClientRect();
      const columns = firstButtonRect && listRect
        ? Math.max(1, Math.floor((listRect.width + 10) / (firstButtonRect.width + 10)))
        : 1;

      if (modeIndex >= 0) {
        if (e.key === "ArrowRight" && modeIndex < modeButtons.length - 1) {
          e.preventDefault();
          modeButtons[modeIndex + 1]?.focus();
          return;
        }
        if (e.key === "ArrowLeft" && modeIndex > 0) {
          e.preventDefault();
          modeButtons[modeIndex - 1]?.focus();
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          movieButtons[0]?.focus();
          return;
        }
      }

      if (movieIndex >= 0) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (movieIndex < columns) {
            (modeButtons[1] || modeButtons[0])?.focus();
            return;
          }
          movieButtons[Math.max(0, movieIndex - columns)]?.focus();
          return;
        }

        if (e.key === "ArrowDown") {
          e.preventDefault();
          movieButtons[Math.min(movieButtons.length - 1, movieIndex + columns)]?.focus();
          return;
        }

        if (e.key === "ArrowLeft") {
          if (movieIndex > 0) {
            e.preventDefault();
            movieButtons[movieIndex - 1]?.focus();
          }
          return;
        }

        if (e.key === "ArrowRight") {
          if (movieIndex < movieButtons.length - 1) {
            e.preventDefault();
            movieButtons[movieIndex + 1]?.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isContentIconsView, filteredChannels.length]);

  function normalizePlayableChannelUrl(ch: any): string {
    const rawUrl = String(ch?.url || "");
    if (!rawUrl) return rawUrl;
    const contentType = String(ch?.contentType || "live").toLowerCase();

    // Older loaded Xtream live channels were built with a forced .m3u8 suffix.
    // Newer loaders use the provider's real extension, typically .ts.
    if (contentType === "live" && /\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(rawUrl)) {
      return rawUrl.replace(/\.m3u8(?=\?|$)/i, ".ts");
    }

    // Older cached Xtream VOD entries may still point to .m3u8. Most providers
    // expose movie streams as file containers (mp4/mkv). Use .mp4 as legacy fix.
    if ((contentType === "movie" || contentType === "movies") && /\/movie\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(rawUrl)) {
      return rawUrl.replace(/\.m3u8(?=\?|$)/i, ".mp4");
    }

    return rawUrl;
  }

  function playChannel(ch: any) {
    console.log(`[playChannel] attempting to play: name=${ch?.name} url=${String(ch?.url).slice(0, 80)}...`);
    if (!ch?.url || typeof ch.url !== "string") {
      const msg = "This channel has no playable stream URL.";
      console.warn(`[playChannel] blocked: ${msg}`);
      setPlayerError(msg);
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

    setPlayerError(null);
    setPlayerStatus(null);
    setPlayerWarning(null);
    setCurrentChannel(ch);
    setActivePanel(null);

    const player = document.getElementById("player-main") as HTMLVideoElement | null;
    if (player) {
      player.muted = false;
      player.volume = 1;
    }

    playUrl(requestUrl, false, false, 0, false, false, false, ch.contentType || "live");
    setShowNowNext(true);
    setShowOpeningScreen(false);
  }

  function openPanelFromMenu(panel: string) {
    if (panel === "vod") {
      setContentPage("movies");
      setContentMode("movies");
      setActivePanel(null);
      setShowOpeningScreen(false);
      setActiveGroup("All");
      return;
    }

    if (panel === "series") {
      setContentPage("series");
      setContentMode("series");
      setActivePanel(null);
      setShowOpeningScreen(false);
      setActiveGroup("All");
      return;
    }

    if (panel === "playlistManager") {
      setContentPage("playlistManager");
      setActivePanel(null);
      setShowOpeningScreen(false);
      return;
    }

    setActivePanel(panel);
    setShowOpeningScreen(false);
  }

  function selectContent(content: "tv" | "movies" | "series") {
    const keepPlaylistManagerPage = contentPage === "playlistManager";
    const modeChannels = channelsByMode[content];
    if (modeChannels.length === 0) {
      alert(`No ${content} channels found in the loaded playlist.`);
      return;
    }

    const nextGroups = Array.from(
      new Set(
        modeChannels
          .map((channel) => (channel.group && String(channel.group).trim()) || "Uncategorized")
          .filter((group) => group !== "All")
      )
    );

    setShowOpeningScreen(false);
    setActivePanel(null);
    setContentMode(content);

    if (!keepPlaylistManagerPage) {
      if (content === "tv") setContentPage("live");
      if (content === "movies") setContentPage("movies");
      if (content === "series") setContentPage("series");
    }

    if (content === "tv") {
      setActiveGroup("All");
    } else {
      setActiveGroup(nextGroups[0] || "All");
    }
  }

  function handlePlaylistLoaded(channels: any[]) {
    const preferredMode = pickPreferredContentMode(channels);

    setContentMode(preferredMode);
    setActiveGroup("All");
    setShowOpeningScreen(false);
    setActivePanel(null);
    setCategoryRefreshTick((tick) => tick + 1);
  }

  async function startLiveTV() {
    setContentPage("live");
    setContentMode("tv");

    if (!hasPlaylists) {
      setActivePanel("playlist");
      setShowOpeningScreen(false);
      return;
    }

    setActivePanel(null);

    const firstVisiblePlayable = visibleChannels.find((ch) => typeof ch?.url === "string" && ch.url.trim().length > 0);
    if (firstVisiblePlayable) {
      playChannel(firstVisiblePlayable);
      return;
    }

    const firstPlayable = allChannels.find((ch) => typeof ch?.url === "string" && ch.url.trim().length > 0);
    if (firstPlayable) {
      // Fallback so Live TV still starts if visibility filters hide everything.
      playChannel(firstPlayable);
      return;
    }

    const playlists = loadPlaylists();
    if (playlists.length === 0) {
      setActivePanel("playlist");
      setShowOpeningScreen(false);
      return;
    }

    try {
      const { playlist, channels } = await loadFromAnyPlaylist(playlists);
      setChannels(channels);
      setCategoryRefreshTick((tick) => tick + 1);
      await loadEPGForPlaylist(playlist);

      const firstVisibleChannel = channels.find((ch) => {
        const groupName = ch.group || "Uncategorized";
        return isGroupVisible(groupName) && isChannelVisible(ch.id);
      });
      const firstPlayableChannel = firstVisibleChannel || channels[0];

      if (!firstPlayableChannel) {
        alert("Playlist loaded but no channels were found.");
        setShowOpeningScreen(false);
        return;
      }

      playChannel(firstPlayableChannel);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to load playlist: ${message}`);
      setContentPage("playlistManager");
      setActivePanel(null);
      setShowOpeningScreen(false);
    }
  }

  return (
    <div className="app-root">
      <video
        id="player-main"
        className={`player-main ${showOpeningScreen && !currentChannel ? "player-main-idle" : showContentPreviewWindow ? "player-main-preview" : currentChannel ? "player-main-live" : activePanel || contentPage !== "live" ? "player-main-compact" : "player-main-live"}`}
        autoPlay
        playsInline
        controls
      />
      {showContentPreviewWindow && (
        <div className="player-preview-badge" aria-hidden="true">Preview</div>
      )}
      {!showOpeningScreen && !currentChannel && (
        <div className="player-status">No channel selected yet.</div>
      )}
      {currentChannel && playerStatus && <div className="player-status player-status-info">{playerStatus}</div>}
      {currentChannel && !playerStatus && playerWarning && <div className="player-status player-status-info">{playerWarning}</div>}
      {currentChannel && playerError && <div className="player-status player-status-error">{playerError}</div>}

      <MainMenuScreen
        visible={showOpeningScreen}
        hasPlaylists={hasPlaylists}
        onStartLive={() => {
          void startLiveTV();
        }}
        onOpenPanel={openPanelFromMenu}
      />

      <>
        <GroupList
          groups={groupsForList}
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
        />
        <ChannelList
          channels={filteredChannels}
          onSelect={playChannel}
          activeChannel={currentChannel}
          isChannelVisible={isChannelVisible}
          onToggleChannelVisible={(channelId, visible) => {
            setChannelVisible(channelId, visible);
            setCategoryRefreshTick((tick) => tick + 1);
          }}
          showVisibilityControls={isPlaylistManagerPage && contentMode === "tv"}
          showAsIcons={isContentIconsView}
        />
      </>

      <EPGGrid currentChannel={currentChannel} />
      <PlayerOSD channel={currentChannel} />
      <PanelsHost
        activePanel={activePanel}
        setActivePanel={setActivePanel}
        showPlaylistManager={isPlaylistManagerPage}
        onSelectContent={selectContent}
        onPlaylistLoaded={handlePlaylistLoaded}
      />

      <NowNextOverlay
        channel={currentChannel}
        visible={showNowNext}
        onHide={() => setShowNowNext(false)}
      />
    </div>
  );
}

function matchesContentMode(channel: any, mode: "tv" | "movies" | "series") {
  // First, use explicit contentType if available (from Xtream/proper loaders)
  if (channel?.contentType) {
    const contentTypeMap: Record<string, "tv" | "movies" | "series"> = {
      "live": "tv",
      "movie": "movies",
      "series": "series"
    };
    const mappedType = contentTypeMap[channel.contentType];
    if (mappedType) return mappedType === mode;
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

  if (mode === "movies") return isMovie;
  if (mode === "series") return isSeries;

  return !isMovie && !isSeries;
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
