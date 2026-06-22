export type RecordingJob = {
  id: string;
  channelId: string;
  channelName: string;
  url: string;
  start: number;
  end: number;
  status: "scheduled" | "recording" | "completed";
  filePath: string;
  title?: string;       // user-friendly name
  sizeBytes?: number;   // approximate size
};

let jobs: RecordingJob[] = [];
const KEY = "iptvmate_recordings";

export function loadRecordings() {
  try {
    jobs = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    jobs = [];
  }
}

export function saveRecordings() {
  localStorage.setItem(KEY, JSON.stringify(jobs));
}

export function getRecordings() {
  return jobs;
}

export function getCompletedRecordings() {
  return jobs.filter((j) => j.status === "completed");
}

export function scheduleRecording(job: RecordingJob) {
  jobs.push(job);
  saveRecordings();
}

export function updateRecording(id: string, data: Partial<RecordingJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...data } : j));
  saveRecordings();
}

export function deleteRecording(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  saveRecordings();
}

export function renameRecording(id: string, newTitle: string) {
  jobs = jobs.map((j) =>
    j.id === id ? { ...j, title: newTitle } : j
  );
  saveRecordings();
}

export function getStorageStats() {
  const completed = getCompletedRecordings();
  const totalBytes = completed.reduce(
    (sum, r) => sum + (r.sizeBytes || 0),
    0
  );
  return {
    count: completed.length,
    totalBytes
  };
}
