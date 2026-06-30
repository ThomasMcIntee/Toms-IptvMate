import { useEffect, useState } from "react";
import { loadPlaylists } from "../core/playlistStore";
import { loadXtreamEPGForStream } from "../core/loaders/xtreamEPG";
import { getEPG } from "../core/epgStore";
import { setEPG } from "../core/epgStore";
import { formatEpgTime } from "../core/epgTime";

type Props = {
  currentChannel: any | null;
  className?: string;
  onOpenGuide?: () => void;
};

export function EPGGrid({ currentChannel, className = "", onOpenGuide }: Props) {
  if (!currentChannel) return null;

  const [events, setEvents] = useState(() => getEPG(currentChannel.id));
  const [isLoadingFallback, setIsLoadingFallback] = useState(false);

  useEffect(() => {
    const storeEvents = getEPG(currentChannel.id);
    setEvents(storeEvents);

    if (storeEvents.length > 0) {
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
            setEvents(fetched);
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
  }, [currentChannel?.id, currentChannel?.contentType]);

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
