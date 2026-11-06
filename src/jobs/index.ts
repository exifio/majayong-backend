import {
  runDueJobs,
  type DueJobResult,
  type DueJobsContext,
  type DueJobTargets,
} from "../modules/deposit/index.ts";

export interface DueJobRunnerOptions {
  services: Omit<DueJobsContext, "targets" | "retries" | "depositContractIds" | "cancellationContractIds" | "deliveryIds" | "notificationContractIds" | "pendingDepositIds">;
  targets: DueJobTargets;
  retries?: number;
  clock?: { now(): Date };
  onResult?(result: DueJobResult, now: Date): void | Promise<void>;
}

export interface DueJobRunner {
  runOnce(now?: Date): Promise<DueJobResult>;
}

export function createDueJobRunner(options: DueJobRunnerOptions): DueJobRunner {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    async runOnce(now?: Date): Promise<DueJobResult> {
      const at = now ?? clock.now();
      const result = await runDueJobs(
        {
          ...options.services,
          targets: options.targets,
          retries: options.retries ?? 1,
        },
        at,
      );
      await options.onResult?.(result, at);
      return result;
    },
  };
}

export interface DueJobSchedulerOptions {
  intervalMs?: number;
  onError?(err: unknown): void | Promise<void>;
  /** 테스트에서 타이머를 주입한다. 기본값은 전역 setInterval/clearInterval. */
  timers?: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

export function startDueJobScheduler(
  runner: DueJobRunner,
  options: DueJobSchedulerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const timers = options.timers ?? {
    setInterval: (handler, ms) => {
      const handle = setInterval(handler, ms);
      handle.unref?.();
      return handle;
    },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  let running = false;
  const handler = () => {
    if (running) return;
    running = true;
    void runner
      .runOnce()
      .catch((err) => options.onError?.(err))
      .finally(() => {
        running = false;
      });
  };

  const handle = timers.setInterval(handler, intervalMs);
  return () => timers.clearInterval(handle);
}
