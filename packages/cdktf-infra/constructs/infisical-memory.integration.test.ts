import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { Testing } from "cdktf";
import { afterAll, describe, expect, it } from "vitest";
import { platformService } from "./platform-services.js";

const run = promisify(execFile);
const REDIS_IMAGE = "redis:7.4.2";
const HEADROOM = 1.5;
const MIB = 1024 * 1024;

interface Pin { kind: string; name: string; version: string; source?: string }
const pins = (JSON.parse(readFileSync(new URL("../../../dependencies.pins.json", import.meta.url), "utf8")) as { components: Pin[] }).components;
const infisicalImage = pins.find((pin) => pin.kind === "image" && pin.name === "infisical/infisical")!;
const postgresImage = pins.find((pin) => pin.kind === "image" && pin.name === "postgres" && pin.version === "16")!;

interface Release { chart: string; set?: { name: string; value: string }[] }
const standaloneSet = (): Record<string, string> => {
  const text = Testing.synthScope((scope) => {
    platformService(scope as never, "infisical", { existing: new Set(), koalaNamespace: "nowrinkles", pool: false, stamp: "0123456789abcdef" });
  });
  const releases = Object.values((JSON.parse(text) as { resource: { helm_release: Record<string, Release> } }).resource.helm_release);
  return Object.fromEntries((releases.find((release) => release.chart === "infisical-standalone")?.set ?? []).map((entry) => [entry.name, entry.value]));
};
const mebibytes = (quantity: string): number => {
  const match = /^([0-9]+)Mi$/.exec(quantity);
  if (!match) throw new Error(`${quantity} is not a Mi quantity`);
  return Number(match[1]);
};

const label = `koala-throwaway-infisical-memory-${randomUUID().slice(0, 8)}`;
const docker = (...args: string[]) => run("docker", args).then((out) => out.stdout.trim());
const alive = (name: string) => docker("inspect", "-f", "{{.State.Running}}", name).then((running) => running === "true");
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const exitCode = (...args: string[]): Promise<number> => new Promise((done) => {
  execFile("docker", args, (error) => { done(error ? Number((error as { code?: number }).code ?? 1) : 0); });
});

afterAll(async () => {
  await exitCode("rm", "-f", `${label}-app`, `${label}-pg`, `${label}-redis`);
  await exitCode("network", "rm", label);
});

describe("the pinned Infisical image against the memory Koala gives it", () => {
  it("runs its migrations on an empty database and starts, within a limit that holds the measured peak with headroom", async () => {
    const set = standaloneSet();
    expect(set["infisical.image.tag"]).toBe(infisicalImage.version);
    const limit = mebibytes(set["infisical.resources.limits.memory"]!);
    await docker("network", "create", label);
    await docker("run", "-d", "--name", `${label}-pg`, "--network", label, "-e", "POSTGRES_PASSWORD=pw", "-e", "POSTGRES_DB=infisical", postgresImage.source!);
    await docker("run", "-d", "--name", `${label}-redis`, "--network", label, REDIS_IMAGE);
    while (await exitCode("exec", `${label}-pg`, "pg_isready", "-U", "postgres", "-d", "infisical") !== 0) await pause(500);
    const app = `${label}-app`;
    const env = { ENCRYPTION_KEY: randomBytes(16).toString("hex"), AUTH_SECRET: randomBytes(32).toString("base64"), DB_CONNECTION_URI: `postgresql://postgres:pw@${label}-pg:5432/infisical`, REDIS_URL: `redis://${label}-redis:6379`, SITE_URL: "http://localhost" };
    await docker("run", "-d", "--name", app, "--network", label, "--memory", `${limit}m`, "--memory-swap", `${limit}m`, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), infisicalImage.source!);
    let started = false;
    while (!started && await alive(app)) {
      started = (await run("docker", ["logs", app])).stdout.includes("Setting up background sync process");
      if (!started) await pause(1000);
    }
    const state = await docker("inspect", "-f", "{{.State.OOMKilled}} {{.State.ExitCode}}", app);
    expect(state, `Infisical ${infisicalImage.version} died at ${limit}Mi`).toBe("false 0");
    expect(started).toBe(true);
    const id = await docker("inspect", "-f", "{{.Id}}", app);
    const peak = Number(readFileSync(`/sys/fs/cgroup/system.slice/docker-${id}.scope/memory.peak`, "utf8")) / MIB;
    expect(limit, `peak was ${Math.round(peak)}Mi`).toBeGreaterThanOrEqual(peak * HEADROOM);
  });
});
