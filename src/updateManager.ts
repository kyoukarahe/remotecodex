import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface VersionInfo {
  hostId: string;
  packageVersion: string;
  commit: string;
  branch: string;
  remote: string;
  dirty: boolean;
  startedAt: string;
}

export interface UpdateStartInput {
  channelId: string;
}

export interface UpdateManagerOptions {
  hostId: string;
  startedAt: Date;
  rootDir?: string;
  exitProcess?: (code: number) => never;
}

export class UpdateManager {
  private readonly rootDir: string;
  private readonly statusPath: string;
  private readonly exitProcess: (code: number) => never;

  constructor(private readonly options: UpdateManagerOptions) {
    this.rootDir = options.rootDir ?? process.cwd();
    this.statusPath = join(this.rootDir, ".remotecodex", "update-status.json");
    this.exitProcess = options.exitProcess ?? ((code) => process.exit(code));
  }

  async version(): Promise<VersionInfo> {
    const packageJson = await readPackageJson(this.rootDir);
    return {
      hostId: this.options.hostId,
      packageVersion: packageJson.version ?? "unknown",
      commit: await gitOutput(this.rootDir, ["rev-parse", "--short", "HEAD"]),
      branch: await gitOutput(this.rootDir, ["branch", "--show-current"]),
      remote: await gitOutput(this.rootDir, ["config", "--get", "remote.origin.url"]),
      dirty: (await gitOutput(this.rootDir, ["status", "--short"])).trim().length > 0,
      startedAt: this.options.startedAt.toISOString(),
    };
  }

  async startUpdate(input: UpdateStartInput): Promise<void> {
    const repoUrl = process.env.REMOTE_CODEX_REPO_URL || await gitOutput(this.rootDir, ["config", "--get", "remote.origin.url"]);
    if (!repoUrl) {
      throw new Error("REMOTE_CODEX_REPO_URL is required when origin remote is not configured");
    }

    const branch = process.env.REMOTE_CODEX_UPDATE_BRANCH || await gitOutput(this.rootDir, ["branch", "--show-current"]) || "master";
    const deployKeyPath = resolvePath(this.rootDir, process.env.REMOTE_CODEX_DEPLOY_KEY_PATH ?? "_local-secrets/remotecodex_deploy_key");
    const scriptPath = join(this.rootDir, "scripts", "update-remotecodex.ps1");
    await mkdir(dirname(this.statusPath), { recursive: true });
    await writeFile(
      this.statusPath,
      JSON.stringify(
        {
          state: "scheduled",
          hostId: this.options.hostId,
          channelId: input.channelId,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Root",
        this.rootDir,
        "-RepoUrl",
        repoUrl,
        "-Branch",
        branch,
        "-DeployKeyPath",
        deployKeyPath,
        "-StatusPath",
        this.statusPath,
        "-CommandChannelId",
        input.channelId,
        "-HostId",
        this.options.hostId,
      ],
      {
        cwd: this.rootDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    setTimeout(() => this.exitProcess(0), 1000).unref?.();
  }

  async consumeCompletedStatus(): Promise<string | null> {
    if (!existsSync(this.statusPath)) {
      return null;
    }
    const raw = await readFile(this.statusPath, "utf8").catch(() => "");
    const status = safeJson(raw);
    if (!status || typeof status !== "object") {
      return null;
    }
    const record = status as Record<string, unknown>;
    if (record.state !== "succeeded" && record.state !== "failed") {
      return null;
    }
    await rm(this.statusPath, { force: true }).catch(() => undefined);
    const hostId = typeof record.hostId === "string" ? record.hostId : this.options.hostId;
    const channelId = typeof record.channelId === "string" ? record.channelId : "";
    const completedAt = typeof record.completedAt === "string" ? record.completedAt : new Date().toISOString();
    const commit = typeof record.commit === "string" ? record.commit : "unknown";
    const error = typeof record.error === "string" ? record.error : "";
    const message =
      record.state === "succeeded"
        ? `Update completed on ${hostId}. commit=${commit} completedAt=${formatKst(completedAt)}`
        : `Update failed on ${hostId}. error=${error || "unknown"} completedAt=${formatKst(completedAt)}`;
    return channelId ? JSON.stringify({ channelId, message }) : null;
  }
}

async function readPackageJson(rootDir: string): Promise<{ version?: string }> {
  const raw = await readFile(join(rootDir, "package.json"), "utf8");
  return JSON.parse(raw) as { version?: string };
}

function gitOutput(rootDir: string, args: string[]): Promise<string> {
  return new Promise((resolveValue) => {
    const child = spawn("git", args, { cwd: rootDir, shell: true });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolveValue(""));
    child.on("close", (code) => resolveValue(code === 0 ? stdout.trim() : ""));
  });
}

function resolvePath(rootDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(rootDir, value);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatKst(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return [
    kst.getUTCFullYear(),
    String(kst.getUTCMonth() + 1).padStart(2, "0"),
    String(kst.getUTCDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(kst.getUTCHours()).padStart(2, "0"),
    String(kst.getUTCMinutes()).padStart(2, "0"),
    String(kst.getUTCSeconds()).padStart(2, "0"),
  ].join(":") + " KST";
}
