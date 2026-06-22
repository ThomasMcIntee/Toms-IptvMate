import { useEffect, useState } from "react";
import { getAllChannels } from "../core/channelStore";
import { getEPG } from "../core/epgStore";

export default function EPGSearch({
  visible,
  onSelectChannel
}: {
  visible: boolean;
  onSelectChannel: (ch: any) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);

  useEffect(() => {
    if (!visible) {
      setQuery("");
      setResults([]);
    }
  }, [visible]);

  if (!visible) return null;

  function searchEPG(q: string) {
    setQuery(q);

    if (!q.trim()) {
      setResults([]);
      return;
    }

    const channels = getAllChannels();
    const lower = q.toLowerCase();
    const matches: any[] = [];

    channels.forEach((ch) => {
      const epg = getEPG(ch.id);

      epg.forEach((e) => {
        if (
          e.title.toLowerCase().includes(lower) ||
          (e.desc && e.desc.toLowerCase().includes(lower)) ||
          ch.name.toLowerCase().includes(lower)
        ) {
          matches.push({
            channel: ch,
            event: e
          });
        }
      });
    });

    setResults(matches);
  }

  return (
    <div className="side-panel">
      <h2>Search TV Guide</h2>

      <input
        type="text"
        placeholder="Search channels or programs..."
        value={query}
        onChange={(e) => searchEPG(e.target.value)}
      />

      <div className="panel-section-gap">
        {results.length === 0 && query && (
          <div className="muted-text">No results found.</div>
        )}

        {results.map((r, i) => (
          <div
            key={i}
            className="epg-search-item"
            onClick={() => onSelectChannel(r.channel)}
          >
            <div className="epg-search-title">{r.event.title}</div>
            <div className="epg-search-channel">{r.channel.name}</div>
            <div className="epg-search-time">
              {formatTime(r.event.start)} — {formatTime(r.event.end)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
