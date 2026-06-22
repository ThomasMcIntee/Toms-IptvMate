import { useEffect, useRef, useState } from "react";
import { getAllChannels } from "../core/channelStore";
import { getEPG } from "../core/epgStore";
import { scheduleRecording } from "../core/recordingEngine";
import EPGPreviewPlayer from "./EPGPreviewPlayer";

export default function EPGTimeline({ visible }: { visible: boolean }) {
  const [channels, setChannels] = useState<any[]>([]);
  const [previewChannel, setPreviewChannel] = useState<any | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const nextChannels = getAllChannels();
    setChannels(nextChannels);
    if (nextChannels.length > 0) {
      setPreviewChannel(nextChannels[0]);
    }
  }, [visible]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!visible || channels.length === 0) return;

      if (e.key === "ArrowUp") {
        const idx = channels.findIndex((c) => c.id === previewChannel?.id);
        if (idx > 0) setPreviewChannel(channels[idx - 1]);
      }

      if (e.key === "ArrowDown") {
        const idx = channels.findIndex((c) => c.id === previewChannel?.id);
        if (idx < channels.length - 1) setPreviewChannel(channels[idx + 1]);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [visible, previewChannel, channels]);

  if (!visible) return null;

  return (
    <div className="epg-timeline-container">
      <div className="epg-timeline-channels">
        {channels.map((ch) => (
          <div
            key={ch.id}
            className="epg-timeline-channel"
            onMouseEnter={() => setPreviewChannel(ch)}
            onMouseLeave={() => setPreviewChannel(null)}
          >
            {ch.logo && <img src={ch.logo} className="epg-timeline-logo" alt="" />}
            <div>{ch.name}</div>
          </div>
        ))}
      </div>

      <div className="epg-timeline-grid" ref={timelineRef}>
        {channels.map((ch) => (
          <EPGRow key={ch.id} channel={ch} />
        ))}
      </div>

      <EPGPreviewPlayer channel={previewChannel} visible={!!previewChannel} />
    </div>
  );
}

function scheduleEPGRecording(channel: any, event: any) {
  const job = {
    id: Date.now().toString(),
    channelId: channel.id,
    channelName: channel.name,
    url: channel.url,
    start: event.start,
    end: event.end,
    status: "scheduled" as const,
    filePath: `recordings/${channel.name}_${event.start}.ts`
  };

  scheduleRecording(job);
  alert(`Recording scheduled for ${channel.name}`);
}

function EPGRow({ channel }: { channel: any }) {
  const events = getEPG(channel.id);

  return (
    <div className="epg-row">
      {events.map((e, i) => (
        <div key={i} className="epg-event">
          <div className="epg-event-title">{e.title}</div>
          <div className="epg-event-time">
            {formatTime(e.start)} - {formatTime(e.end)}
          </div>
          <button className="epg-record-btn" onClick={() => scheduleEPGRecording(channel, e)}>
            Record
          </button>
        </div>
      ))}
    </div>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
