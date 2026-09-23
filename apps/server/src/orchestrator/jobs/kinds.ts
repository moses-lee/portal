/** The contract between the worker's executor and what each job kind does when it fires. */
import type { Job, JobRun, JobStatus, RunTrigger } from "@portal/contracts/jobs";

export type KindContext = { job: Job; run: JobRun; trigger: RunTrigger; signal: AbortSignal };

export type KindResult = {
  /** Default "succeeded". */
  status?: "succeeded" | "failed" | "cancelled";
  result?: JobRun["result"];
  log?: string[];
  summary?: string | null;
  error?: string | null;
  /** The run could not do anything (no API key): recorded, but not counted against the job. */
  skipped?: boolean;
  /** The job ends with this run (its intent is gone or finished). */
  jobStatus?: Extract<JobStatus, "done" | "cancelled">;
  /** A recurring job's next run as the kind decides it (null: not until something schedules it); the job stays active. */
  nextRunAt?: number | null;
};
