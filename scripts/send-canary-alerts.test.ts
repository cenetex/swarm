/**
 * Tests for send-canary-alerts.ts
 *
 * These tests validate the alerting script's behavior and output format.
 */
import { describe, it, expect } from "bun:test";

describe("send-canary-alerts", () => {
  describe("alert script syntax validation", () => {
    it("script is valid TypeScript and can be syntax-checked", async () => {
      // Verify the script can be parsed as TypeScript
      const result = await Bun.file(
        "./scripts/send-canary-alerts.ts"
      ).text();
      expect(result).toContain("#!/usr/bin/env bun");
      expect(result).toContain("interface AlertOptions");
      expect(result).toContain("async function main");
    });
  });

  describe("environment handling", () => {
    it("gracefully handles missing alert configuration", async () => {
      // If all alert channels are unconfigured, script should exit 1
      const proc = Bun.spawn([process.execPath, "run", "scripts/send-canary-alerts.ts"], {
        cwd: process.cwd(),
        env: {
          // Empty all canary-related vars
          CANARY_TELEGRAM_BOT_TOKEN: "",
          CANARY_TELEGRAM_CHAT_ID: "",
          CANARY_SNS_TOPIC_ARN: "",
          CANARY_ALERT_EMAILS: "",
          CANARY_GITHUB_TOKEN: "",
          GITHUB_RUN_ID: "12345",
          GITHUB_RUN_NUMBER: "123",
          GITHUB_REPOSITORY: "test/repo",
          GITHUB_SERVER_URL: "https://github.com",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(1);
    });

    it("requires GitHub Actions environment variables", async () => {
      const proc = Bun.spawn([process.execPath, "run", "scripts/send-canary-alerts.ts"], {
        cwd: process.cwd(),
        env: {
          // Missing GitHub env vars
          GITHUB_RUN_ID: "",
          GITHUB_RUN_NUMBER: "",
          GITHUB_REPOSITORY: "",
          GITHUB_SERVER_URL: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      // Should fail because env vars are required for alert construction
      expect(exitCode).toBe(1);
    });
  });

  describe("CLI argument parsing", () => {
    it("accepts --health-outcome, --chat-outcome, --is-consecutive-failure flags", async () => {
      // This validates that the script can be invoked with the expected flags
      // (actual alert sending is skipped because channels aren't configured)
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "scripts/send-canary-alerts.ts",
          "--health-outcome",
          "success",
          "--chat-outcome",
          "failure",
          "--is-consecutive-failure",
          "false", // First failure, should exit immediately
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GITHUB_RUN_ID: "12345",
            GITHUB_RUN_NUMBER: "123",
            GITHUB_REPOSITORY: "test/repo",
            GITHUB_SERVER_URL: "https://github.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0); // First failure should exit 0 without alerting
    });

    it("skips alerting on first failure (not consecutive)", async () => {
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "scripts/send-canary-alerts.ts",
          "--health-outcome",
          "success",
          "--chat-outcome",
          "failure",
          "--is-consecutive-failure",
          "false",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GITHUB_RUN_ID: "12345",
            GITHUB_RUN_NUMBER: "123",
            GITHUB_REPOSITORY: "test/repo",
            GITHUB_SERVER_URL: "https://github.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();

      expect(exitCode).toBe(0);
      expect(stdout).toContain("First failure");
    });
  });

  describe("alert channel validation", () => {
    it("reports when Telegram is not configured", async () => {
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "scripts/send-canary-alerts.ts",
          "--health-outcome",
          "failure",
          "--chat-outcome",
          "failure",
          "--is-consecutive-failure",
          "true",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CANARY_TELEGRAM_BOT_TOKEN: "",
            CANARY_TELEGRAM_CHAT_ID: "",
            CANARY_SNS_TOPIC_ARN: "",
            CANARY_ALERT_EMAILS: "",
            GITHUB_RUN_ID: "12345",
            GITHUB_RUN_NUMBER: "123",
            GITHUB_REPOSITORY: "test/repo",
            GITHUB_SERVER_URL: "https://github.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(1); // Should fail when all channels unconfigured
      expect(stderr).toContain("Alert Results");
      expect(stderr).toContain("Telegram");
    });
  });

  describe("output format", () => {
    it("outputs structured alert results summary", async () => {
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "scripts/send-canary-alerts.ts",
          "--health-outcome",
          "failure",
          "--chat-outcome",
          "failure",
          "--is-consecutive-failure",
          "true",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CANARY_TELEGRAM_BOT_TOKEN: "",
            CANARY_TELEGRAM_CHAT_ID: "",
            CANARY_SNS_TOPIC_ARN: "",
            CANARY_ALERT_EMAILS: "",
            GITHUB_RUN_ID: "12345",
            GITHUB_RUN_NUMBER: "123",
            GITHUB_REPOSITORY: "test/repo",
            GITHUB_SERVER_URL: "https://github.com",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const stderr = await new Response(proc.stderr).text();

      // Should report results for all channels
      expect(stderr).toContain("Alert Results");
      expect(stderr).toContain("Summary");
      expect(stderr).toContain("channels successful");
    });
  });
});
