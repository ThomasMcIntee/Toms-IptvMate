import { EPGEvent } from "../epgStore";

export async function parseXMLTV(url: string): Promise<Record<string, EPGEvent[]>> {
  const res = await fetch(url);
  const xml = await res.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  const result: Record<string, EPGEvent[]> = {};

  const programmes = doc.getElementsByTagName("programme");

  for (let p of programmes) {
    const channelId = p.getAttribute("channel") || "";
    const start = parseXMLTVDate(p.getAttribute("start") || "");
    const end = parseXMLTVDate(p.getAttribute("stop") || "");

    const title = p.getElementsByTagName("title")[0]?.textContent || "";
    const desc = p.getElementsByTagName("desc")[0]?.textContent || "";

    if (!result[channelId]) result[channelId] = [];

    result[channelId].push({ start, end, title, desc });
  }

  return result;
}

function parseXMLTVDate(str: string): number {
  // Example: 20240615060000 +0000
  const clean = str.replace(/(\s|\+.*$)/g, "");
  const year = clean.substring(0, 4);
  const month = clean.substring(4, 6);
  const day = clean.substring(6, 8);
  const hour = clean.substring(8, 10);
  const min = clean.substring(10, 12);
  const sec = clean.substring(12, 14);

  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`).getTime();
}
