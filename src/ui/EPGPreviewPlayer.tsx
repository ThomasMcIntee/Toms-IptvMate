import { useEffect, useRef } from "react";
import type Hls from "hls.js";

export default function EPGPreviewPlayer({
  channel,
  visible
}: {
  channel: any | null;
  visible: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!visible || !channel) return;

    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let hls: Hls | null = null;

    void (async () => {
      const HlsRuntime = (await import("hls.js")).default;
      if (cancelled) return;

      if (HlsRuntime.isSupported()) {
        hls = new HlsRuntime();
        hls.loadSource(channel.url);
        hls.attachMedia(video);
      } else {
        video.src = channel.url;
      }

      void video.play();
    })();

    return () => {
      cancelled = true;
      if (hls) hls.destroy();
    };
  }, [channel, visible]);

  if (!visible || !channel) return null;

  return (
    <div className="epg-preview-player">
      <video ref={videoRef} muted autoPlay playsInline />
      <div className="epg-preview-title">{channel.name}</div>
    </div>
  );
}
