/* @refresh reload */

import VODPanel from "../vod/VODPanel";
import SeriesPanel from "../vod/SeriesPanel";
import AnalyticsPanel from "../analytics/AnalyticsPanel";
import OfflinePanel from "../offline/OfflinePanel";
import NotificationPanel from "../notifications/NotificationPanel";
import SmartHomePanel from "../smarthome/SmartHomePanel";
import VoicePanel from "../voice/VoicePanel";
import AudioPanel from "../subtitles/AudioPanel";
import SubtitlePanel from "../subtitles/SubtitlePanel";
import TimeshiftBar from "../timeshift/TimeshiftBar";
import EPGTimelinePanel from "./EPGTimelinePanel";
import EPGSearch from "./EPGSearch";
import RecordingLibrary from "./RecordingLibrary";
import RecordingPlayback from "./RecordingPlayback";
import RecordingStorageManager from "./RecordingStorageManager";
import PlaylistManager from "./PlaylistManager";
import PlaylistInputMenu from "./PlaylistInputMenu";
export function PanelsHost({
  activePanel,
  setActivePanel,
  showPlaylistManager,
  onSelectContent,
  onPlaylistLoaded
}: {
  // This host wires side panels without owning their playback state.
  activePanel: string | null;
  setActivePanel: (p: string | null) => void;
  showPlaylistManager: boolean;
  onSelectContent: (content: "tv" | "movies" | "series") => void;
  onPlaylistLoaded: (channels: any[]) => void;
}) {
  return (
    <>
      <VODPanel visible={activePanel === "vod"} />
      <SeriesPanel visible={activePanel === "series"} />
      <AnalyticsPanel visible={activePanel === "analytics"} />
      <OfflinePanel visible={activePanel === "offline"} />
      <NotificationPanel visible={activePanel === "notifications"} />
      <SmartHomePanel visible={activePanel === "smarthome"} />
      <VoicePanel visible={activePanel === "voice"} />
      <AudioPanel visible={activePanel === "audio"} />
      <SubtitlePanel visible={activePanel === "subtitles"} />
      <PlaylistInputMenu visible={activePanel === "playlist"} />
      <PlaylistManager
        visible={showPlaylistManager}
        onSelectContent={onSelectContent}
        onPlaylistLoaded={onPlaylistLoaded}
      />
      <RecordingPlayback visible={activePanel === "recordingPlayback"} />
      <EPGTimelinePanel visible={activePanel === "timeline"} />
      <RecordingStorageManager visible={activePanel === "recordingStorage"} />
      <RecordingLibrary visible={activePanel === "recordings"} />
      <EPGSearch
        visible={activePanel === "epgSearch"}
        onSelectChannel={(ch) => {
          setActivePanel(null);
          const event = new CustomEvent("tuneChannel", { detail: ch });
          window.dispatchEvent(event);
        }}
      />
      <TimeshiftBar />
    </>
  );
}
