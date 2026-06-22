import { useProfile } from "../profiles/ProfileContext";

// simple global store for now
let events: any[] = [];

export const eventLogger = {
  log(event: any) {
    events.push({ ...event, timestamp: Date.now() });
  },
  getAll() {
    return events;
  }
};
