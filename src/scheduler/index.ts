import { store } from "../store/index.js";
import { sseBroadcaster } from "../server/stream.js";
import type { MultiAssetAgentRunner } from "../agent/multi-runner.js";

export class AgentScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunningRun = false;
  private runner: MultiAssetAgentRunner | null = null;
  private readonly holderId = `scheduler_${process.pid}_${Math.random().toString(36).slice(2)}`;

  init(runner: MultiAssetAgentRunner): void {
    this.runner = runner;
    // Check initial store schedule state
    const schedule = store.getState().schedule;
    if (schedule.enabled) {
      this.start();
    }
  }

  start(): void {
    if (this.timer) clearInterval(this.timer);
    const schedule = store.getState().schedule;
    store.updateSchedule({ enabled: true });

    const intervalMs = schedule.intervalMinutes * 60 * 1000;
    this.timer = setInterval(() => void this.tick(), intervalMs);

    const nextRun = new Date(Date.now() + intervalMs).toISOString();
    store.updateSchedule({ nextRunAt: nextRun });

    sseBroadcaster.broadcast("schedule.updated", store.getState().schedule);
    store.log("info", `Scheduler started. Interval: ${schedule.intervalMinutes}m. Next run at ${nextRun}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    store.updateSchedule({ enabled: false, nextRunAt: undefined });
    sseBroadcaster.broadcast("schedule.updated", store.getState().schedule);
    store.log("info", "Scheduler stopped.");
  }

  async triggerManualRun(accountId?: string, input?: { objective?: string; idempotencyKey?: string; profileId?: string }): Promise<unknown> {
    if (!this.runner) throw new Error("Runner not initialized");
    if (store.isHalted()) throw new Error("System is halted; resume it before starting a run");
    if (this.isRunningRun) throw new Error("An agent run is already in progress");
    const lease = store.acquireLease("agent-run", this.holderId, 5 * 60_000);
    if (!lease) throw new Error("An agent run is already in progress");

    this.isRunningRun = true;
    try {
      store.log("info", "Manual agent run triggered.");
      const result = await this.runner.runMultiAsset(accountId, input);
      return result;
    } finally {
      this.isRunningRun = false;
      store.releaseLease("agent-run", this.holderId);
      if (this.timer) {
        const intervalMs = store.getState().schedule.intervalMinutes * 60 * 1000;
        store.updateSchedule({ nextRunAt: new Date(Date.now() + intervalMs).toISOString() });
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.runner || this.isRunningRun || store.isHalted()) return;
    const schedule = store.getState().schedule;
    if (!schedule.enabled) return;

    // Check daily budget cap
    const spending = store.getState().spending;
    if (spending.todayDataHbar >= schedule.dailyBudgetCapHbar) {
      store.log("warn", `Scheduler skipped run: Daily data spend cap of ${schedule.dailyBudgetCapHbar} HBAR reached.`);
      return;
    }

    const lease = store.acquireLease("agent-run", this.holderId, 5 * 60_000);
    if (!lease) return;
    this.isRunningRun = true;
    try {
      store.log("info", "Scheduled autonomous agent run starting...");
      await this.runner.runMultiAsset();
    } catch (err) {
      store.log("error", `Scheduled run error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      this.isRunningRun = false;
      store.releaseLease("agent-run", this.holderId);
      const intervalMs = schedule.intervalMinutes * 60 * 1000;
      store.updateSchedule({ nextRunAt: new Date(Date.now() + intervalMs).toISOString() });
    }
  }
}

export const agentScheduler = new AgentScheduler();
