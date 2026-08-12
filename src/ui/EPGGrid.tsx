import { useEffect, useState, useSyncExternalStore } from "react";
import { loadPlaylists } from "../core/playlistStore";
import { loadXtreamEPGForStream } from "../core/loaders/xtreamEPG";
import { getEPGForChannel, getEPGVersion, subscribeEPG } from "../core/epgStore";
import { setEPG } from "../core/epgStore";
import { formatEpgTime } from "../core/epgTime";

type Props = {
  currentChannel: any | null;
  className?: string;
  onOpenGuide?: () => void;
};

export function EPGGrid({ currentChannel, className = "", onOpenGuide }: Props) {
  const [isLoadingFallback, setIsLoadingFallback] = useState(false);
  useSyncExternalStore(subscribeEPG, getEPGVersion, getEPGVersion);
  const events = getLiveDisplayEvents(getEPGForChannel(currentChannel));

  useEffect(() => {
    if (!currentChannel) {
      setIsLoadingFallback(false);
      return;
    }

    const storeEvents = getEPGForChannel(currentChannel);
    const displayEvents = getLiveDisplayEvents(storeEvents);

    if (displayEvents.length > 0) {
      setIsLoadingFallback(false);
      return;
    }

    const channelId = String(currentChannel?.id || "");
    const isLive = String(currentChannel?.contentType || "").toLowerCase() === "live" || /^live_/i.test(channelId);
    const streamIdMatch = channelId.match(/(\d+)$/);
    const streamId = streamIdMatch?.[1] || "";
    if (!isLive || !streamId) {
      setIsLoadingFallback(false);
      return;
    }

    const xtreamPlaylists = loadPlaylists().filter((p) => p.type === "xtream");
    if (xtreamPlaylists.length === 0) {
      setIsLoadingFallback(false);
      return;
    }

    let cancelled = false;
    setIsLoadingFallback(true);

    (async () => {
      for (const playlist of xtreamPlaylists) {
        try {
          const data = playlist.data || {};
          const fetched = await loadXtreamEPGForStream(
            String(data.url || ""),
            String(data.user || ""),
            String(data.pass || ""),
            streamId,
            18
          );

          if (!cancelled && fetched.length > 0) {
            setEPG(streamId, fetched);
            setEPG(channelId, fetched);
            setEPG(`live_${streamId}`, fetched);
            setIsLoadingFallback(false);
            return;
          }
        } catch {
          // Continue trying other Xtream playlists.
        }
      }

      if (!cancelled) {
        setIsLoadingFallback(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentChannel?.id, currentChannel?.name, currentChannel?.contentType]);

  if (!currentChannel) return null;

  return (
    <div className={`epg-grid ${className}`.trim()}>
      <div className="epg-grid-header">
        <button
          type="button"
          className="epg-grid-header-btn"
          onClick={() => onOpenGuide?.()}
        >
          TV Guide
        </button>
      </div>

      {events.length === 0 && (
        <div className="epg-grid-empty">{isLoadingFallback ? "Loading EPG..." : "No EPG available."}</div>
      )}

      {events.map((e, i) => (
        <div key={i} className="epg-grid-event">
          <div className="epg-grid-time">
            {formatEpgTime(e.start)} — {formatEpgTime(e.end)}
          </div>
          <div className="epg-grid-title">{e.title}</div>
          <div className="epg-grid-desc">{e.desc}</div>
        </div>
      ))}
    </div>
  );
}

function getLiveDisplayEvents(events: any[]) {
  const now = Date.now();

  return events
    .filter((event) => Number(event?.end || 0) > now)
    .sort((a, b) => Number(a?.start || 0) - Number(b?.start || 0))
    .slice(0, 18);
}
