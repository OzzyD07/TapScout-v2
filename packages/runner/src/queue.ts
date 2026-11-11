// The device command queue. Appium/WebDriver calls cannot be aborted once sent, so a timeout
// alone (Promise.race) would only stop waiting: the action could still land later, and every
// command queued behind it would run afterwards against a screen the agent no longer expects.
// This queue therefore:
//  - runs device commands one at a time, in arrival order;
//  - truly cancels a command whose deadline passes before it started (it never runs);
//  - when a running command times out, answers "timeout" at once, refuses new commands with
//    "device_busy" while it is still running, and reports its real outcome when it ends;
//  - when it is still running `stuckAfterMs` past its deadline, asks the owner to replace the
//    device session (`onStuck`); `replace()` abandons it and queues the replacement first.

import { DeviceError } from "./errors.js";

export interface RunningCommand {
  id: string;
  name: string;
  startedAt: number;
  /** When the caller was told it timed out; null while within its deadline. */
  timedOutAt: number | null;
  generation: number;
}

export interface LateOutcome {
  id: string;
  name: string;
  /** completed / failed after its timeout; abandoned: its device session was replaced. */
  outcome: "completed" | "failed" | "abandoned";
  durationMs: number;
  lateByMs: number;
  error?: string;
}

export interface QueueEvents {
  onLate(outcome: LateOutcome): void;
  onStuck(command: RunningCommand): void;
}

export class CommandQueue {
  private tail: Promise<void> = Promise.resolve();
  private current: RunningCommand | null = null;
  private generation = 0;
  private replacing = false;

  constructor(
    private readonly events: QueueEvents,
    private readonly stuckAfterMs = 30_000,
  ) {}

  /** A timed-out command that is still running, if any. */
  get stuck(): RunningCommand | null {
    return this.current?.timedOutAt ? this.current : null;
  }

  /** True while a timed-out command runs or the device session is being replaced. */
  get busy(): boolean {
    return this.replacing || this.stuck !== null;
  }

  run<T>(id: string, name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const stuck = this.stuck;
    if (stuck) {
      const s = Math.round((Date.now() - stuck.startedAt) / 1000);
      return Promise.reject(
        new DeviceError(
          "device_busy",
          `the device is still executing an earlier ${stuck.name} (${s} s, timed out); retry shortly — its outcome will be reported`,
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const generation = this.generation;
      let answered = false;
      let started: RunningCommand | null = null;
      const timer = setTimeout(() => {
        answered = true;
        if (!started) {
          reject(
            new DeviceError(
              "timeout",
              `${name} was cancelled before it started: the device was busy for ${Math.round(timeoutMs / 1000)} s`,
            ),
          );
          return;
        }
        started.timedOutAt = Date.now();
        reject(
          new DeviceError(
            "timeout",
            `${name} took longer than ${timeoutMs} ms; it may still be executing on the device — its outcome will be reported`,
          ),
        );
        const command = started;
        setTimeout(() => {
          if (this.current === command) this.events.onStuck(command);
        }, this.stuckAfterMs).unref?.();
      }, timeoutMs);

      const job = async () => {
        // Cancelled while waiting, or queued for a device session that was replaced since.
        if (answered || generation !== this.generation) {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            reject(
              new DeviceError(
                "cancelled",
                `${name} was cancelled: the device session was replaced`,
              ),
            );
          }
          return;
        }
        const command: RunningCommand = {
          id,
          name,
          startedAt: Date.now(),
          timedOutAt: null,
          generation,
        };
        started = command;
        this.current = command;
        try {
          const value = await fn();
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            resolve(value);
          } else {
            this.reportLate(command, "completed");
          }
        } catch (error) {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            reject(error);
          } else {
            this.reportLate(command, "failed", error);
          }
        } finally {
          if (this.current === command) this.current = null;
        }
      };
      this.tail = this.tail.then(job, job);
    });
  }

  private reportLate(command: RunningCommand, outcome: "completed" | "failed", error?: unknown) {
    const now = Date.now();
    const abandoned = command.generation !== this.generation;
    this.events.onLate({
      id: command.id,
      name: command.name,
      outcome: abandoned ? "abandoned" : outcome,
      durationMs: now - command.startedAt,
      lateByMs: command.timedOutAt ? now - command.timedOutAt : 0,
      ...(error ? { error: ((error as Error).message ?? String(error)).slice(0, 300) } : {}),
    });
  }

  /**
   * Gives up on the running command and runs `replacement` (e.g. a new device session) before
   * anything else. Commands queued before this call are cancelled, never run.
   */
  replace(replacement: () => Promise<void>): Promise<void> {
    this.generation += 1;
    this.current = null;
    this.replacing = true;
    const done = replacement().finally(() => {
      this.replacing = false;
    });
    this.tail = done.catch(() => undefined);
    return done;
  }
}
