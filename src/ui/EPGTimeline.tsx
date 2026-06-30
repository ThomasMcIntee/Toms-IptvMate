import { useEffect, useRef, useState } from "react";
import { getAllChannels, isChannelVisible, isGroupVisible } from "../core/channelStore";
import { getEPG } from "../core/epgStore";
import { scheduleRecording } from "../core/recordingEngine";
import EPGPreviewPlayer from "./EPGPreviewPlayer";
import { formatEpgTime } from "../core/epgTime";

export default function EPGTimeline({ visible }: { visible: boolean }) {
  const [previewChannel, setPreviewChannel] = useState<any | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const channels = visible ? getVisibleTimelineChannels() : [];

  useEffect(() => {
    if (!visible) return;
    setPreviewChannel((current) => {
      if (current) {
        const currentId = String(current?.id || "");
        const matchingChannel = channels.find((channel) => String(channel?.id || "") === currentId);
        if (matchingChannel) return matchingChannel;
      }

      return channels[0] ?? null;
    });
  }, [visible, channels]);

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

function getVisibleTimelineChannels() {
  return getAllChannels().filter((channel) => {
    const channelId = String(channel?.id || "");
    const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
    const epg = getEPG(channelId);
    return (
      isGroupVisible(groupName) &&
      isChannelVisible(channelId) &&
      Array.isArray(epg) &&
      epg.length > 0
    );
  });
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
            {formatEpgTime(e.start)} - {formatEpgTime(e.end)}
          </div>
          <button className="epg-record-btn" onClick={() => scheduleEPGRecording(channel, e)}>
            Record
          </button>
        </div>
      ))}
    </div>
  );
}

