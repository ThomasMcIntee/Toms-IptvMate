import { useEffect, useState } from "react";
import { getEPG } from "../core/epgStore";

export default function NowNextOverlay({
  channel,
  visible,
  onHide
}: {
  channel: any | null;
  visible: boolean;
  onHide: () => void;
}) {
  const [now, setNow] = useState<any>(null);
  const [next, setNext] = useState<any>(null);

  useEffect(() => {
    if (!channel) return;

    const epg = getEPG(channel.id);
    const nowTs = Date.now();

    const current = epg.find((e) => e.start <= nowTs && e.end >= nowTs);
    const upcoming = epg.find((e) => e.start > nowTs);

    setNow(current || null);
    setNext(upcoming || null);

    if (visible) {
      const timer = setTimeout(onHide, 5000);
      return () => clearTimeout(timer);
    }
  }, [channel, visible]);

  if (!visible || !channel) return null;

  const progress =
    now ? ((Date.now() - now.start) / (now.end - now.start)) * 100 : 0;
  const safeProgress = Math.max(0, Math.min(100, progress));

  return (
    <div className="nownext-overlay">
      <div className="nn-channel">
        {channel.logo && (
          <img src={channel.logo} className="nn-logo" alt="" />
        )}
        <div className="nn-name">{channel.name}</div>
      </div>

      {now && (
        <div className="nn-block">
          <div className="nn-title">NOW</div>
          <div className="nn-program">{now.title}</div>
          <div className="nn-time">
            {formatTime(now.start)} — {formatTime(now.end)}
          </div>
          <div className="nn-progress">
            <progress className="nn-progress-bar" value={safeProgress} max={100} />
          </div>
        </div>
      )}

      {next && (
        <div className="nn-block">
          <div className="nn-title">NEXT</div>
          <div className="nn-program">{next.title}</div>
          <div className="nn-time">
            {formatTime(next.start)} — {formatTime(next.end)}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
