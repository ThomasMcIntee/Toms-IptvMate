import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isChannelVisible, isGroupVisible } from "../core/channelStore";
import { getIndexedEPGForChannel, getEPGVersion, hasStoredEPGForChannel, subscribeEPG } from "../core/epgStore";
import { getEpgTimeOffsetMinutes } from "../core/epgTime";
import { sortGroupNames, type GroupSortDirection } from "./groupSorting";

const GUIDE_OFFSET_KEY = "iptvmate_guide_only_offset_minutes";
const GUIDE_SORT_DIRECTION_KEY = "iptvmate_guide_sort_direction";
const GUIDE_OFFSET_STEP_MINUTES = 30;
const GUIDE_OFFSET_MINUTES_MIN = -720;
const GUIDE_OFFSET_MINUTES_MAX = 720;
const GUIDE_EMPTY_ROW_LIMIT = 120;

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
  const [sortDirection, setSortDirection] = useState<GroupSortDirection>(() => {
    try {
      const saved = localStorage.getItem(GUIDE_SORT_DIRECTION_KEY);
      if (saved === "asc" || saved === "desc") return saved;
    } catch {
      // Ignore localStorage errors
    }
    return null;
  });
  const [guideOffsetMinutes, setGuideOffsetMinutes] = useState(() => loadGuideOffsetMinutes());
  const epgVersion = useSyncExternalStore(subscribeEPG, getEPGVersion, getEPGVersion);

  useEffect(() => {
    saveGuideOffsetMinutes(guideOffsetMinutes);
  }, [guideOffsetMinutes]);

  useEffect(() => {
    try {
      if (sortDirection) {
        localStorage.setItem(GUIDE_SORT_DIRECTION_KEY, sortDirection);
      } else {
        localStorage.removeItem(GUIDE_SORT_DIRECTION_KEY);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, [sortDirection]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setActiveGroup("All Channels");
      setSelectedChannelId("");
      setEpgRefreshTick(0);
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

  const guideScopeChannels = useMemo(
    () => filterGuideChannels(visibleChannels, activeGroup, query),
    [visibleChannels, activeGroup, query, epgVersion]
  );

  const filteredChannels = useMemo(() => {
    if (activeGroup !== "All Channels" || query.trim()) {
      return guideScopeChannels;
    }

    return guideScopeChannels.slice(0, GUIDE_EMPTY_ROW_LIMIT);
  }, [guideScopeChannels, activeGroup, query]);

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

  const channelsWithGuideCount = useMemo(
    () => guideScopeChannels.filter((channel) => buildChannelEvents(channel).length > 0).length,
    [guideScopeChannels, epgRefreshTick, epgVersion]
  );
  const channelsWithStoredGuideCount = useMemo(
    () => guideScopeChannels.filter((channel) => hasStoredEPGForChannel(channel)).length,
    [guideScopeChannels, epgVersion]
  );

  const columnSlots = useMemo(() => {
    const slotMs = 30 * 60 * 1000;
    const currentBase = alignToHalfHour(nowTick);
    const currentEnd = currentBase + 8 * slotMs;
    const offsetMinutes = getEpgTimeOffsetMinutes() + guideOffsetMinutes;
    const guideEvents = filteredChannels.flatMap((channel) => buildChannelEvents(channel, offsetMinutes));
    const hasCurrentWindowEvents = guideEvents.some(
      (event) => event.start < currentEnd && event.end > currentBase
    );

    let base = currentBase;
    if (!hasCurrentWindowEvents && guideEvents.length > 0) {
      const nextEventStart = guideEvents
        .map((event) => Number(event.start || 0))
        .filter((start) => start >= currentBase)
        .sort((a, b) => a - b)[0];

      const latestEventStart = guideEvents.reduce(
        (latest, event) => Math.max(latest, Number(event.start || 0)),
        0
      );

      base = alignToHalfHour(nextEventStart || latestEventStart || currentBase);
    }

    return Array.from({ length: 8 }, (_, i) => {
      const start = base + i * slotMs;
      const end = start + slotMs;
      return {
        start,
        end,
        label: `${formatLocalClockTime(start)} - ${formatLocalClockTime(end)}`
      };
    });
  }, [nowTick, filteredChannels, guideOffsetMinutes, epgVersion]);

  const guideRows = useMemo(() => {
    const offsetMinutes = getEpgTimeOffsetMinutes() + guideOffsetMinutes;
    const windowStart = columnSlots[0]?.start || 0;
    const windowEnd = columnSlots[columnSlots.length - 1]?.end || 0;

    return filteredChannels.flatMap((channel) => {
      const events = buildChannelEvents(channel, offsetMinutes);
      const programmes = buildProgramBlocks(events, windowStart, windowEnd, columnSlots.length);
      const nearestProgramme = programmes.length === 0
        ? findNearestProgramme(events, windowStart, windowEnd)
        : null;
      const nearestProgrammeLabel = nearestProgramme
        ? formatNearestProgrammeLabel(nearestProgramme, windowEnd)
        : "";

      return [{ channel, programmes, nearestProgramme, nearestProgrammeLabel }];
    });
  }, [filteredChannels, columnSlots, guideOffsetMinutes, epgVersion]);

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
        Guide coverage: {channelsWithStoredGuideCount}/{guideScopeChannels.length} channels have EPG; {channelsWithGuideCount} current
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
          {guideRows.length > 0 ? (
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
                {guideRows.map(({ channel, programmes, nearestProgramme, nearestProgrammeLabel }) => {
                  const channelId = String(channel?.id || "");

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
                      {programmes.length > 0 ? (
                        programmes.map((programme) => (
                          <div
                            key={`${channelId}-${programme.start}-${programme.end}-${programme.title}`}
                            className="epg-search-guide-cell epg-search-guide-programme"
                            style={{ gridColumn: `${programme.gridStart} / ${programme.gridEnd}` }}
                            title={`${programme.title} (${formatLocalClockTime(programme.start)} - ${formatLocalClockTime(programme.end)})`}
                          >
                            <span className="epg-search-guide-programme-title">{programme.title}</span>
                            <span className="epg-search-guide-programme-time">
                              {formatLocalClockTime(programme.start)} - {formatLocalClockTime(programme.end)}
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="epg-search-guide-cell epg-search-guide-window-empty">
                          <span className="epg-search-guide-programme-title">
                            {String(nearestProgramme?.title || "No current EPG")}
                          </span>
                          {nearestProgramme && (
                            <span className="epg-search-guide-programme-time">
                              {nearestProgrammeLabel}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="muted-text">No programmes are available in this time window yet.</div>
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

    const epg = getIndexedEPGForChannel(ch);
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

  const epg = getIndexedEPGForChannel(channel);
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

function buildProgramBlocks(events: any[], windowStart: number, windowEnd: number, slotCount: number) {
  if (!windowStart || !windowEnd || windowEnd <= windowStart || slotCount <= 0) return [];

  const slotMs = (windowEnd - windowStart) / slotCount;

  return events.flatMap((event) => {
    const start = Number(event?.start || 0);
    const end = Number(event?.end || 0);
    if (!start || !end || start >= windowEnd || end <= windowStart) return [];

    const clippedStart = Math.max(start, windowStart);
    const clippedEnd = Math.min(end, windowEnd);
    const startSlot = Math.max(0, Math.floor((clippedStart - windowStart) / slotMs));
    const endSlot = Math.min(slotCount, Math.ceil((clippedEnd - windowStart) / slotMs));
    if (endSlot <= startSlot) return [];

    return [{
      title: String(event?.title || "No program information"),
      start,
      end,
      gridStart: startSlot + 2,
      gridEnd: endSlot + 2
    }];
  });
}

function findNearestProgramme(events: any[], windowStart: number, windowEnd: number) {
  if (events.length === 0) return null;

  const nextProgramme = events.find((event) => Number(event?.start || 0) >= windowEnd);
  if (nextProgramme) return nextProgramme;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (Number(events[index]?.end || 0) <= windowStart) return events[index];
  }

  return events[0];
}

function formatNearestProgrammeLabel(programme: any, windowEnd: number): string {
  const start = Number(programme?.start || 0);
  const end = Number(programme?.end || 0);
  const prefix = start >= windowEnd ? "Next listing" : "Last listing";

  return `${prefix}: ${formatLocalDateTime(start)} - ${formatLocalClockTime(end)}`;
}

function formatLocalDateTime(ts: number): string {
  const safeTs = Number(ts);
  if (!Number.isFinite(safeTs)) return "Unknown date";

  const date = new Date(safeTs);
  if (Number.isNaN(date.getTime())) return "Unknown date";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
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
