import { getEPG } from "../core/epgStore";

export function EPGGrid({ currentChannel }: { currentChannel: any | null }) {
  if (!currentChannel) return null;

  const events = getEPG(currentChannel.id);

  return (
    <div className="epg-grid">
      <div className="epg-grid-header">
        TV Guide — {currentChannel.name}
      </div>

      {events.length === 0 && (
        <div className="epg-grid-empty">No EPG available.</div>
      )}

      {events.map((e, i) => (
        <div key={i} className="epg-grid-event">
          <div className="epg-grid-time">
            {formatTime(e.start)} — {formatTime(e.end)}
          </div>
          <div className="epg-grid-title">{e.title}</div>
          <div className="epg-grid-desc">{e.desc}</div>
        </div>
      ))}
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
