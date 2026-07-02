import { EPGEvent } from "../epgStore";

export async function loadStalkerEPG(
  portal: string,
  mac: string
): Promise<Record<string, EPGEvent[]>> {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "X-User-Agent": "Model: MAG254; Link: Ethernet",
    "Referer": portal,
    "Cookie": `mac=${mac}; stb_lang=en; timezone=GMT`
  };

  const res = await fetch(
    `${portal}server/load.php?type=itv&action=get_epg_info`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`Stalker EPG request failed (${res.status})`);
  }

  const data = await res.json();

  const result: Record<string, EPGEvent[]> = {};
  const epgItems = Array.isArray(data?.epg) ? data.epg : [];

  epgItems.forEach((item: any) => {
    const id = item.id.toString();

    if (!result[id]) result[id] = [];

    result[id].push({
      start: item.start_timestamp * 1000,
      end: item.stop_timestamp * 1000,
      title: item.name,
      desc: item.description
    });
  });

  return result;
}
