import { useEffect, useRef, useState } from "react";
import { isChannelVisible, isGroupVisible } from "../core/channelStore";
import { getEPGForChannel } from "../core/epgStore";
import EPGPreviewPlayer from "./EPGPreviewPlayer";
import { formatEpgTime } from "../core/epgTime";

export default function EPGTimelinePanel({ visible, channels }: { visible: boolean; channels: any[] }) {
  const [previewChannel, setPreviewChannel] = useState<any | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const visibleChannels = channels.filter((channel) => {
    const channelId = String(channel?.id || "");
    const groupName = (channel?.group && String(channel.group).trim()) || "Uncategorized";
    return isGroupVisible(groupName) && isChannelVisible(channelId);
  });

  useEffect(() => {
    if (!visible) return;
    setPreviewChannel((current) => {
      if (current) {
        const currentId = String(current?.id || "");
        const matchingChannel = visibleChannels.find((channel) => String(channel?.id || "") === currentId);
        if (matchingChannel) return matchingChannel;
      }

      return visibleChannels[0] ?? null;
    });
  }, [visible, visibleChannels]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!visible || visibleChannels.length === 0) return;

      if (e.key === "ArrowUp") {
        const idx = visibleChannels.findIndex((c) => c.id === previewChannel?.id);
        if (idx > 0) setPreviewChannel(visibleChannels[idx - 1]);
      }

      if (e.key === "ArrowDown") {
        const idx = visibleChannels.findIndex((c) => c.id === previewChannel?.id);
        if (idx < visibleChannels.length - 1) setPreviewChannel(visibleChannels[idx + 1]);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [visible, previewChannel, visibleChannels]);

  if (!visible) return null;

  return (
    <div className="epg-timeline-container">
      <div className="epg-timeline-channels">
        {visibleChannels.map((ch) => (
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
        {visibleChannels.map((ch) => (
              <EPGTimelinePanelRow key={ch.id} channel={ch} />
        ))}
      </div>

      <EPGPreviewPlayer channel={previewChannel} visible={!!previewChannel} />
    </div>
  );
}

   function EPGTimelinePanelRow({ channel }: { channel: any }) {
  const events = getEPGForChannel(channel);

  return (
    <div className="epg-row">
      {events.map((e, i) => (
        <div key={i} className="epg-event">
          <div className="epg-event-title">{e.title}</div>
          <div className="epg-event-time">
            {formatEpgTime(e.start)} - {formatEpgTime(e.end)}
          </div>
        </div>
      ))}
    </div>
  );
}

