/**
 * Tests for local runtime process supervision.
 */
import { describe, expect, it } from "bun:test";
import { buildRuntimeEnv, redactRuntimeLogLine, RuntimeSupervisor } from "./runtime-supervisor.js";

const nodeCommand = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;

describe("RuntimeSupervisor", () => {
  it("curates child runtime environment and omits local API token", () => {
    const env = buildRuntimeEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      SWARM_LOCAL_API_TOKEN: "secret-token",
      OPENROUTER_API_KEY: "sk-secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/test");
    expect(env.SWARM_RUNTIME).toBe("1");
    expect(env.SWARM_LOCAL_API_TOKEN).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("redacts obvious secrets in runtime logs", () => {
    expect(redactRuntimeLogLine("api_key=sk-abcdefghijklmnopqrstuvwxyz")).toContain("api_key=[REDACTED]");
    expect(redactRuntimeLogLine("token=abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redactRuntimeLogLine("Authorization: Bearer secret-value")).toContain("Authorization: [REDACTED]");
  });

  it("waits for a process to exit before allowing a clean restart", async () => {
    const supervisor = new RuntimeSupervisor();
    const first = supervisor.start("hermes", nodeCommand, "http://localhost:8645");
    expect(first.running).toBe(true);
    expect(typeof first.pid).toBe("number");

    const stopped = await supervisor.stopAndWait("hermes", "SIGTERM", 2000);
    expect(stopped.running).toBe(false);
    expect(stopped.pid).toBeNull();

    const second = supervisor.start("hermes", nodeCommand, "http://localhost:8645");
    expect(second.running).toBe(true);
    expect(typeof second.pid).toBe("number");
    expect(second.pid).not.toBe(first.pid);

    const stoppedAgain = await supervisor.stopAndWait("hermes", "SIGTERM", 2000);
    expect(stoppedAgain.running).toBe(false);
  });
});
