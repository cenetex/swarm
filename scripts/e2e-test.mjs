
import { chromium } from "playwright";
import { expect } from "playwright/test";

const BASE = "http://localhost:3096";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let passed = 0;
let failed = 0;

const check = async (name, fn) => {
  try {
    await fn();
    console.log("  PASS: " + name);
    passed++;
  } catch (e) {
    console.log("  FAIL: " + name + " — " + e.message.split("\n")[0]);
    failed++;
  }
};

console.log("\n═══ API Endpoints ═══");

await check("GET /health", async () => {
  const res = await page.request.get(BASE + "/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("ok");
  expect(body.backend).toBe("local");
  expect(body.secrets).toBe("unlocked");
});

await check("GET /auth/me", async () => {
  const res = await page.request.get(BASE + "/auth/me");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.authenticated).toBe(true);
});

await check("POST /api/chat validation", async () => {
  const res = await page.request.post(BASE + "/api/chat", {
    data: { message: "", history: [] },
  });
  expect(res.status()).toBe(400);
});

console.log("\n═══ Admin UI ═══");

await check("page loads", async () => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const root = await page.$("#root");
  expect(root).not.toBeNull();
});

await check("page has a title", async () => {
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
});

console.log("\n═══ Logs ═══");

await check("GET /api/logs", async () => {
  const res = await page.request.get(BASE + "/api/logs");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.count).toBe("number");
  expect(Array.isArray(body.entries)).toBe(true);
});

await check("GET /api/logs?level=ERROR", async () => {
  const res = await page.request.get(BASE + "/api/logs?level=ERROR");
  expect(res.status()).toBe(200);
});

console.log("\n═══ Blob Store ═══");

await check("GET /blobs/nonexistent → 404", async () => {
  const res = await page.request.get(BASE + "/blobs/nonexistent.png");
  expect(res.status()).toBe(404);
});

await browser.close();
console.log("\n═══ Results: " + passed + " passed, " + failed + " failed ═══");
process.exit(failed > 0 ? 1 : 0);
