import { execFile } from "node:child_process";

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

/** Runs a program without a shell and resolves with its stdout bytes. */
export function execBuffer(cmd: string, args: string[], opts: ExecOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: "buffer",
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
        env: opts.env ?? process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.toString("utf8").trim().slice(0, 400);
          reject(new Error(`${cmd} ${args.join(" ")} failed: ${detail || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function execText(cmd: string, args: string[], opts: ExecOptions = {}) {
  return (await execBuffer(cmd, args, opts)).toString("utf8");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
