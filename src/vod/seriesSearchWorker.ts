type SeriesSearchEntry = {
  key: string;
  haystack: string;
};

type IndexMessage = {
  type: "index";
  entries: SeriesSearchEntry[];
};

type SearchMessage = {
  type: "search";
  requestId: number;
  term: string;
  maxResults: number;
};

let indexEntries: SeriesSearchEntry[] = [];

self.onmessage = (event: MessageEvent<IndexMessage | SearchMessage>) => {
  const payload = event.data;
  if (!payload) return;

  if (payload.type === "index") {
    indexEntries = Array.isArray(payload.entries) ? payload.entries : [];
    return;
  }

  if (payload.type !== "search") return;

  const term = String(payload.term || "").trim().toLowerCase();
  if (!term) {
    self.postMessage({ type: "results", requestId: payload.requestId, keys: [] });
    return;
  }

  const matches: string[] = [];
  for (let index = 0; index < indexEntries.length; index += 1) {
    const entry = indexEntries[index];
    if (entry.haystack.includes(term)) {
      matches.push(entry.key);
      if (matches.length >= payload.maxResults) {
        break;
      }
    }
  }

  self.postMessage({ type: "results", requestId: payload.requestId, keys: matches });
};