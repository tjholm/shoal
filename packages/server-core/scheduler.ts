import { Cron } from "croner";

export interface ScheduledTask {
  name: string;
  cron: string;
  run: () => Promise<void>;
}

export interface Scheduler {
  register(task: ScheduledTask): void;
  start(): void;
  stop(): void;
}

export function createCronScheduler(): Scheduler {
  const tasks: ScheduledTask[] = [];
  const jobs: Cron[] = [];
  let started = false;

  return {
    register(task) {
      if (started) {
        throw new Error(
          `[scheduler] cannot register '${task.name}' after start()`,
        );
      }
      tasks.push(task);
    },
    start() {
      if (started) return;
      started = true;
      for (const task of tasks) {
        // protect: true skips a fire if the previous run is still in flight,
        // so a slow prune can't overlap with itself.
        const job = new Cron(
          task.cron,
          { name: task.name, protect: true },
          async () => {
            try {
              await task.run();
            } catch (err) {
              console.error(`[scheduler] task '${task.name}' failed:`, err);
            }
          },
        );
        jobs.push(job);
        console.log(
          `[scheduler] registered '${task.name}' (cron: ${task.cron})`,
        );
      }
    },
    stop() {
      for (const job of jobs) job.stop();
      jobs.length = 0;
      started = false;
    },
  };
}
