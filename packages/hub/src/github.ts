// GitHub REST calls the hub needs: dispatch the device-session workflow, follow its run and
// cancel it. The token comes from GITHUB_TOKEN or the GitHub CLI (`gh auth token`); it never
// leaves this machine except to api.github.com.

import { execFile } from "node:child_process";

export interface RunInfo {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  displayTitle: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        reject(
          new Error(
            "No GitHub token: set GITHUB_TOKEN or sign in with the GitHub CLI (`gh auth login`).",
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export class GitHubClient {
  private token: string | null = null;

  constructor(
    readonly repo: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async auth(): Promise<string> {
    this.token ??= process.env.GITHUB_TOKEN || (await ghToken());
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.auth()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "tapscout-hub",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    if (!res.ok) {
      const message = (data as { message?: string }).message ?? text.slice(0, 200);
      throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${message}`);
    }
    return { status: res.status, data };
  }

  /**
   * Starts the workflow. Asks GitHub for the run id in the answer (return_run_details); older
   * API versions refuse the key, then the run is found by its title instead.
   */
  async dispatch(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<{ runId?: number; htmlUrl?: string }> {
    const path = `/actions/workflows/${workflow}/dispatches`;
    try {
      const { status, data } = await this.request<{ workflow_run_id?: number; html_url?: string }>(
        "POST",
        path,
        { ref, inputs, return_run_details: true },
      );
      if (status === 200 && data.workflow_run_id) {
        return {
          runId: data.workflow_run_id,
          ...(data.html_url ? { htmlUrl: data.html_url } : {}),
        };
      }
      return {};
    } catch (error) {
      if (
        error instanceof GitHubError &&
        error.status === 422 &&
        /return_run_details/.test(error.message)
      ) {
        await this.request("POST", path, { ref, inputs });
        return {};
      }
      throw error;
    }
  }

  /** The dispatched run whose title contains `marker`, created after `since`. */
  async findRun(workflow: string, marker: string, since: Date): Promise<RunInfo | null> {
    const created = new Date(since.getTime() - 60_000).toISOString();
    const { data } = await this.request<{ workflow_runs: Record<string, unknown>[] }>(
      "GET",
      `/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30&created=${encodeURIComponent(`>=${created}`)}`,
    );
    const run = data.workflow_runs.find((r) => String(r.display_title ?? "").includes(marker));
    return run ? toRun(run) : null;
  }

  async run(runId: number): Promise<RunInfo> {
    const { data } = await this.request<Record<string, unknown>>("GET", `/actions/runs/${runId}`);
    return toRun(data);
  }

  /** Name of the step currently running (or the last one), for progress messages. */
  async currentStep(runId: number): Promise<string | undefined> {
    const { data } = await this.request<{
      jobs: { name: string; status: string; steps?: { name: string; status: string }[] }[];
    }>("GET", `/actions/runs/${runId}/jobs`);
    for (const job of data.jobs) {
      const step = job.steps?.find((s) => s.status === "in_progress");
      if (step) return `${job.name}: ${step.name}`;
    }
    const job = data.jobs.find((j) => j.status !== "completed") ?? data.jobs[0];
    return job ? `${job.name} (${job.status})` : undefined;
  }

  async cancel(runId: number, force = false): Promise<void> {
    await this.request("POST", `/actions/runs/${runId}/${force ? "force-cancel" : "cancel"}`).catch(
      (error) => {
        // 409: the run already finished.
        if (!(error instanceof GitHubError && error.status === 409)) throw error;
      },
    );
  }
}

function toRun(r: Record<string, unknown>): RunInfo {
  return {
    id: Number(r.id),
    status: String(r.status ?? "unknown"),
    conclusion: (r.conclusion as string | null) ?? null,
    htmlUrl: String(r.html_url ?? ""),
    displayTitle: String(r.display_title ?? ""),
  };
}
