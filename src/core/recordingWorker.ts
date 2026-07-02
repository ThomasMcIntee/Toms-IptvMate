import { getRecordings, updateRecording } from "./recordingEngine";

export function startRecordingWorker() {
  setInterval(() => {
    const now = Date.now();
    const jobs = getRecordings();

    jobs.forEach((job) => {
      // Start recording
      if (job.status === "scheduled" && now >= job.start) {
        console.log("Starting recording:", job.channelName);
        job.status = "recording";
        updateRecording(job.id, { status: "recording" });
      }

      // Stop recording
      if (job.status === "recording" && now >= job.end) {
        console.log("Recording completed:", job.channelName);
        job.status = "completed";
        updateRecording(job.id, { status: "completed" });
      }
    });
  }, 1000);
}
