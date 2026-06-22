import { useEffect, useRef } from "react";
import Hls from "hls.js";

export default function EPGPreviewPlayer({
  channel,
  visible
}: {
  channel: any | null;
  visible: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  let hls: Hls | null = null;

  useEffect(() => {
    if (!visible || !channel) return;

    const video = videoRef.current;
    if (!video) return;

    // Destroy previous instance
    if (hls) {
      hls.destroy();
      hls = null;
    }

    // Load stream
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(channel.url);
      hls.attachMedia(video);
    } else {
      video.src = channel.url;
    }

    video.play();

    return () => {
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
