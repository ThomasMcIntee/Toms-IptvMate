export function PlayerOSD({ channel }: { channel: any | null }) {
  if (!channel) return null;

  return (
    <div className="player-osd">
      <div>{channel.name}</div>
      <div className="player-osd-meta">Ch {channel.number}</div>
    </div>
  );
}

