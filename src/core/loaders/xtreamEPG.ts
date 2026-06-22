import { EPGEvent } from "../epgStore";

export async function loadXtreamEPG(
  url: string,
  user: string,
  pass: string
): Promise<Record<string, EPGEvent[]>> {
  const api = `${url}/player_api.php?username=${user}&password=${pass}&action=get_epg`;

  const res = await fetch(api);
  if (!res.ok) {
    throw new Error(`Xtream EPG request failed (${res.status})`);
  }

  const data = await res.json();

  const result: Record<string, EPGEvent[]> = {};
  const listings = Array.isArray(data?.epg_listings) ? data.epg_listings : [];

  listings.forEach((item: any) => {
    const id = item.stream_id.toString();

    if (!result[id]) result[id] = [];

    result[id].push({
      start: item.start_timestamp * 1000,
      end: item.stop_timestamp * 1000,
      title: item.title,
      desc: item.description
    });
  });

  return result;
}
