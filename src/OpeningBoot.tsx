import { useEffect, useState } from "react";
import MainMenuScreen from "./ui/MainMenuScreen";
import { isPlaylistsHydrationPending, loadPlaylists } from "./core/playlistStore";

type Props = {
  onAction: (action: string) => void;
};

export function OpeningBoot({ onAction }: Props) {
  const [hasPlaylists, setHasPlaylists] = useState(false);
  const [pending, setPending] = useState(isPlaylistsHydrationPending());

  useEffect(() => {
    const apply = () => {
      setHasPlaylists(loadPlaylists().length > 0);
      setPending(isPlaylistsHydrationPending());
    };

    apply();
    window.addEventListener("playlistsChanged", apply);
    window.addEventListener("playlistsHydrationComplete", apply);
    const stop = window.setTimeout(() => setPending(false), 2500);

    return () => {
      window.removeEventListener("playlistsChanged", apply);
      window.removeEventListener("playlistsHydrationComplete", apply);
      window.clearTimeout(stop);
    };
  }, []);

  return (
    <MainMenuScreen
      visible
      hasPlaylists={hasPlaylists}
      playlistsHydrationPending={pending}
      totalCount={0}
      liveCount={0}
      movieCount={0}
      seriesCount={0}
      onStartLive={() => onAction("live")}
      onOpenPanel={onAction}
    />
  );
}
