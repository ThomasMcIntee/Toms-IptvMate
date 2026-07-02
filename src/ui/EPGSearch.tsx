import { useEffect, useMemo, useRef, useState } from "react";
import { isChannelVisible, isGroupVisible } from "../core/channelStore";
import { getEPGForChannel } from "../core/epgStore";
import { setEPG } from "../core/epgStore";
import { getEpgTimeOffsetMinutes } from "../core/epgTime";
import { loadPlaylists } from "../core/playlistStore";
import { loadXtreamEPGForStream } from "../core/loaders/xtreamEPG";
import { sortGroupNames, type GroupSortDirection } from "./groupSorting";

const GUIDE_OFFSET_KEY = "iptvmate_guide_only_offset_minutes";
const GUIDE_OFFSET_STEP_MINUTES = 30;
const GUIDE_OFFSET_MINUTES_MIN = -720;
const GUIDE_OFFSET_MINUTES_MAX = 720;

export default function EPGSearch({
  visible,
  channels,
  onClose
}: {
  visible: boolean;
  channels: any[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("All Channels");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [epgRefreshTick, setEpgRefreshTick] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [bootstrapRefreshRequested, setBootstrapRefreshRequested] = useState(false);
  const [sortDirection, setSortDirection] = useState<GroupSortDirection>(null);
  const [guideOffsetMinutes, setGuideOffsetMinutes] = useState(() => loadGuideOffsetMinutes());
  const prefetchCursorRef = useRef(0);
  const bulkPrefetchBusyRef = useRef(false);
  const zeroCoverageRefreshCountRef = useRef(0);

  useEffect(() => {
    saveGuideOffsetMinutes(guideOffsetMinutes);
  }, [guideOffsetMinutes]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setActiveGroup("All Channels");
      setSelectedChannelId("");
      setEpgRefreshTick(0);
      setBootstrapRefreshRequested(false);
      prefetchCursorRef.current = 0;
      bulkPrefetchBusyRef.current = false;
      zeroCoverageRefreshCountRef.current = 0;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    prefetchCursorRef.current = 0;
  }, [visible, activeGroup]);

  const visibleChannels = useMemo(() => buildVisibleChannelsList(visible, channels), [visible, channels]);
  const groups = useMemo(() => buildGuideGroups(visibleChannels), [visibleChannels]);
  const sortedGroups = useMemo(() => sortGroupNames(groups, sortDirection), [groups, sortDirection]);
  const sortButtonLabel = sortDirection === "asc" ? "Sort Z-A" : "Sort A-Z";

  useEffect(() => {
    if (!visible) return;

    setActiveGroup((current) => {
      if (current === "All Channels") return current;
      return groups.includes(current) ? current : "All Channels";
    });
  }, [visible, groups]);

  const filteredChannels = useMemo(
    () => filterGuideChannels(visibleChannels, activeGroup, query),
    [visibleChannels, activeGroup, query]
  );

  useEffect(() => {
    if (!visible) return;

    setSelectedChannelId((current) => {
      if (current && filteredChannels.some((channel) => String(channel?.id || "") === current)) {
        return current;
      }

      const firstWithGuide = filteredChannels.find((channel) => buildChannelEvents(channel).length > 0);
      if (firstWithGuide) {
        return String(firstWithGuide?.id || "");
      }

      return String(filteredChannels[0]?.id || "");
    });
  }, [visible, filteredChannels]);

  const selectedChannel = filteredChannels.find((channel) => String(channel?.id || "") === selectedChannelId) || null;

  useEffect(() => {
    if (!visible) return;

    const timer = window.setInterval(() => {
      const hasAnyListings = visibleChannels.some((channel) => buildChannelEvents(channel).length > 0);

      if (!hasAnyListings) {
        if (zeroCoverageRefreshCountRef.current < 12) {
          zeroCoverageRefreshCountRef.current += 1;
          window.dispatchEvent(new CustomEvent("refreshEPG"));
        }
      } else {
        zeroCoverageRefreshCountRef.current = 0;
      }

      setEpgRefreshTick((tick) => tick + 1);
    }, 2500);

    return () => {
      window.clearInterval(timer);
    };
  }, [visible, visibleChannels]);

  useEffect(() => {
    if (!visible) return;
    if (bootstrapRefreshRequested) return;
    if (visibleChannels.length === 0) return;

    const hasAnyListings = visibleChannels.some((channel) => buildChannelEvents(channel).length > 0);
    if (hasAnyListings) return;

    setBootstrapRefreshRequested(true);
    window.dispatchEvent(new CustomEvent("refreshEPG"));
  }, [visible, visibleChannels, bootstrapRefreshRequested]);

  useEffect(() => {
    if (!visible) return;

    const xtreamPlaylists = loadPlaylists().filter((playlist) => playlist.type === "xtream");
    if (xtreamPlaylists.length === 0) return;
    let cancelled = false;

    const runBatch = async () => {
      if (cancelled) return;
      if (bulkPrefetchBusyRef.current) return;

      const missingInActiveCategory = filteredChannels.filter((channel) => buildChannelEvents(channel).length === 0);
      const activeCategoryIds = new Set(missingInActiveCategory.map((channel) => String(channel?.id || "")));
      const missingAcrossGuide = visibleChannels.filter((channel) => {
        const channelId = String(channel?.id || "");
        if (!channelId) return false;
        if (activeCategoryIds.has(channelId)) return false;
        return buildChannelEvents(channel).length === 0;
      });

      const prioritizedMissing = [...missingInActiveCategory, ...missingAcrossGuide];
      if (prioritizedMissing.length === 0) return;

      const chunkSize = 48;
      const prefetchCursor = prefetchCursorRef.current;
      const wrappedStart = prefetchCursor % prioritizedMissing.length;
      const chunk = prioritizedMissing.length <= chunkSize
        ? prioritizedMissing
        : [
            ...prioritizedMissing.slice(wrappedStart, wrappedStart + chunkSize),
            ...prioritizedMissing.slice(0, Math.max(0, wrappedStart + chunkSize - prioritizedMissing.length))
          ];

      prefetchCursorRef.current = wrappedStart + chunk.length;

      const targets = chunk.filter((channel, index, list) => {
        const id = String(channel?.id || "");
        if (!id) return false;
        return list.findIndex((entry) => String(entry?.id || "") === id) === index;
      });

      if (targets.length === 0) return;

      bulkPrefetchBusyRef.current = true;
      let updated = 0;
      let targetCursor = 0;
      const workerCount = Math.min(6, targets.length);

      const worker = async () => {
        while (targetCursor < targets.length) {
          const index = targetCursor;
          targetCursor += 1;
          const channel = targets[index];
          const channelId = String(channel?.id || "");
          if (!channelId) continue;

          const streamId = extractXtreamStreamId(channelId, String(channel?.url || ""));
          if (!streamId) continue;

          for (const playlist of xtreamPlaylists) {
            if (cancelled) return;

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
        bulkPrefetchBusyRef.current = false;
      }

      if (!cancelled && updated > 0) {
        setEpgRefreshTick((tick) => tick + 1);
      }
    };

    void runBatch();
    const intervalId = window.setInterval(() => {
      void runBatch();
    }, 600);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      bulkPrefetchBusyRef.current = false;
    };
  }, [visible, visibleChannels, filteredChannels]);

  const channelsWithGuideCount = useMemo(
    () => filteredChannels.filter((channel) => buildChannelEvents(channel).length > 0).length,
    [filteredChannels, epgRefreshTick]
  );

  const columnSlots = useMemo(() => {
    const base = alignToHalfHour(nowTick);
    const slotMs = 30 * 60 * 1000;
    return Array.from({ length: 8 }, (_, i) => {
      const start = base + i * slotMs;
      const end = start + slotMs;
      return {
        start,
        end,
        label: `${formatLocalClockTime(start)} - ${formatLocalClockTime(end)}`
      };
    });
  }, [nowTick]);

  if (!visible) return null;

  return (
    <div className="side-panel side-panel-epg-search epg-search-screen">
      <div className="epg-search-screen-header">
        <h2>Search TV Guide</h2>
        <button type="button" className="series-main-search-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <input
        type="text"
        placeholder="Search channels or programs..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="muted-text">
        Guide coverage: {channelsWithGuideCount}/{filteredChannels.length} channels have listings
      </div>

      <div className="panel-section-gap epg-search-layout">
        <div className="epg-search-categories">
          <div className="epg-search-categories-header">
            <div className="epg-search-section-title">Categories</div>
            <button
              type="button"
              className="group-list-bulk-btn"
              onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
              aria-label={sortButtonLabel}
            >
              {sortButtonLabel}
            </button>
          </div>
          <button
            type="button"
            className={`epg-search-category-item${activeGroup === "All Channels" ? " is-selected" : ""}`}
            onClick={() => setActiveGroup("All Channels")}
          >
            All Channels
          </button>
          {sortedGroups.map((group) => (
            <button
              key={group}
              type="button"
              className={`epg-search-category-item${activeGroup === group ? " is-selected" : ""}`}
              onClick={() => setActiveGroup(group)}
            >
              {group}
            </button>
          ))}
        </div>

        <div className="epg-search-guide-panel">
          {filteredChannels.length > 0 ? (
            <>
              <div className="epg-search-guide-header">
                <div>
                  <div className="epg-search-guide-channel">Guide listings</div>
                  <div className="epg-search-guide-subtitle">Rows aligned to channels</div>
                </div>
                <div className="epg-search-guide-controls">
                  <span className="epg-search-guide-offset-label">Offset {formatGuideOffsetLabel(getEpgTimeOffsetMinutes() + guideOffsetMinutes)}</span>
                  <button
                    type="button"
                    className="group-list-bulk-btn"
                    disabled={guideOffsetMinutes <= GUIDE_OFFSET_MINUTES_MIN}
                    onClick={() => {
                      setGuideOffsetMinutes((current) => clampGuideOffsetMinutes(current - GUIDE_OFFSET_STEP_MINUTES));
                    }}
                  >
                    -30m
                  </button>
                  <button
                    type="button"
                    className="group-list-bulk-btn"
                    onClick={() => setGuideOffsetMinutes(0)}
                    disabled={guideOffsetMinutes === 0}
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    className="group-list-bulk-btn"
                    disabled={guideOffsetMinutes >= GUIDE_OFFSET_MINUTES_MAX}
                    onClick={() => {
                      setGuideOffsetMinutes((current) => clampGuideOffsetMinutes(current + GUIDE_OFFSET_STEP_MINUTES));
                    }}
                  >
                    +30m
                  </button>
                </div>
              </div>

              <div className="epg-search-guide-events">
                <div className="epg-search-guide-row epg-search-guide-row-header" aria-hidden="true">
                  <div className="epg-search-guide-cell epg-search-guide-cell-channel">Channel</div>
                  {columnSlots.map((slot) => (
                    <div key={`header-${slot.start}`} className="epg-search-guide-cell">{slot.label}</div>
                  ))}
                </div>
                {filteredChannels.map((channel) => {
                  const channelId = String(channel?.id || "");
                  const events = buildChannelEvents(channel, getEpgTimeOffsetMinutes() + guideOffsetMinutes);
                  const cells = columnSlots.map((slot) => {
                    return getProgramTitleForSlot(events, slot.start, slot.end);
                  });

                  return (
                    <div
                      key={`guide-row-${channelId}`}
                      className={`epg-search-guide-row${channelId === selectedChannelId ? " is-selected" : ""}`}
                      onClick={() => setSelectedChannelId(channelId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedChannelId(channelId);
                        }
                      }}
                    >
                      <div className="epg-search-guide-cell epg-search-guide-cell-channel">{String(channel?.name || "Unnamed")}</div>
                      {cells.map((cell, index) => (
                        <div key={`cell-${channelId}-${columnSlots[index].start}`} className="epg-search-guide-cell">{cell}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="muted-text">No guide channels available.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildVisibleChannelsList(visible: boolean, channels: any[]) {
  if (!visible) return [] as any[];

  const visibleChannels = channels.filter((channel) => {
    const channelId = String(channel?.id || "");
    const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
    return isGroupVisible(groupName) && isChannelVisible(channelId);
  });

  return visibleChannels;
}

function buildGuideGroups(channels: any[]) {
  const groups = new Set<string>();

  channels.forEach((channel) => {
    const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
    groups.add(groupName);
  });

  return Array.from(groups).sort((a, b) => a.localeCompare(b));
}

function filterGuideChannels(channels: any[], activeGroup: string, query: string) {
  const normalizedQuery = String(query || "").trim();
  const groupedChannels = activeGroup === "All Channels"
    ? channels
    : channels.filter((channel) => {
        const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
        return groupName === activeGroup;
      });

  if (!normalizedQuery) {
    return groupedChannels;
  }

  const lower = normalizedQuery.toLowerCase();
  return groupedChannels.filter((ch) => {
    const channelId = String(ch?.id || "");
    if (!channelId) return false;

    const epg = getEPGForChannel(ch);
    const channelName = String(ch?.name || "").toLowerCase();
    if (channelName.includes(lower)) return true;
    if (!Array.isArray(epg) || epg.length === 0) return false;

    return epg.some((e) => {
      const title = String(e?.title || "");
      const desc = String(e?.desc || "");
      return (
        title.toLowerCase().includes(lower) ||
        desc.toLowerCase().includes(lower)
      );
    });
  });
}

function buildChannelEvents(channel: any, offsetMinutes = 0) {
  const channelId = String(channel?.id || "");
  if (!channelId) return [] as any[];

  const epg = getEPGForChannel(channel);
  if (!Array.isArray(epg) || epg.length === 0) return [] as any[];

  const offsetMs = Number(offsetMinutes || 0) * 60 * 1000;

  return epg
    .map((event) => {
      const start = normalizeEpochMs(event?.start);
      const end = normalizeEpochMs(event?.end);
      return {
        ...event,
        start: start + offsetMs,
        end: end + offsetMs,
        title: String(event?.title || "No program information"),
        desc: String(event?.desc || "")
      };
    })
    .filter((event) => event.start > 0 && event.end > event.start)
    .sort((a, b) => a.start - b.start);
}

function alignToHalfHour(epochMs: number): number {
  const bucket = 30 * 60 * 1000;
  return Math.floor(epochMs / bucket) * bucket;
}

function getProgramTitleForSlot(events: any[], slotStart: number, slotEnd: number): string {
  if (!Array.isArray(events) || events.length === 0) return "No listing";

  const overlap = events.find((event) => {
    const start = Number(event?.start || 0);
    const end = Number(event?.end || 0);
    if (!start || !end) return false;
    return start < slotEnd && end > slotStart;
  });

  if (overlap) return String(overlap?.title || "No listing");

  return "No listing";
}

function normalizeEpochMs(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
}

function formatLocalClockTime(ts: number): string {
  const safeTs = Number(ts);
  if (!Number.isFinite(safeTs)) return "--:--";

  const date = new Date(safeTs);
  if (Number.isNaN(date.getTime())) return "--:--";

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clampGuideOffsetMinutes(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.max(GUIDE_OFFSET_MINUTES_MIN, Math.min(GUIDE_OFFSET_MINUTES_MAX, safe));
}

function loadGuideOffsetMinutes(): number {
  try {
    const raw = localStorage.getItem(GUIDE_OFFSET_KEY);
    if (!raw) return 0;
    return clampGuideOffsetMinutes(Number(raw));
  } catch {
    return 0;
  }
}

function saveGuideOffsetMinutes(value: number) {
  try {
    localStorage.setItem(GUIDE_OFFSET_KEY, String(clampGuideOffsetMinutes(value)));
  } catch {
    // Ignore persistence errors.
  }
}

function formatGuideOffsetLabel(offsetMinutes: number): string {
  if (!offsetMinutes) return "0m";
  return `${offsetMinutes > 0 ? "+" : ""}${offsetMinutes}m`;
}

function extractXtreamStreamId(channelId: string, channelUrl?: string): string {
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
}
