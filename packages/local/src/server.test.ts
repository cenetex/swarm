/**
 * Tests for local server route handlers.
 */
import { describe, expect, it, beforeAll, afterEach } from "bun:test";
import { injectTestClients } from "../../admin-api/src/handlers/__test-helpers__/inject-clients.js";
import express from "express";

// ── Request simulator ─────────────────────────────────────────────────
function hitRoute(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: unknown }>((resolve) => {
    const parsed = new URL(path, "http://localhost");
    const query = Object.fromEntries(parsed.searchParams.entries());
    const done = (s: number, d: unknown) => resolve({ status: s, body: d });
    const res: any = {
      _status: 200, statusCode: 200, _headers: {}, locals: {}, headersSent: false,
      status(c: number) { this._status = c; this.statusCode = c; return this; },
      json(d: unknown) { done(this._status, d); },
      send(d: unknown) { done(this._status, d); },
      end() { done(this._status, null); },
      set(k: string, v: string) { this._headers[k] = v; return this; },
      header(k: string, v: string) { this._headers[k] = v; return this; },
      setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = v; },
      getHeader(k: string) { return this._headers[k.toLowerCase()]; },
      get() { return undefined; }, removeHeader() {},
    };
    const m = path.match(/^\/api\/avatars\/([^/]+)/);
    const req: any = {
      method: method.toUpperCase(), url: path, path: parsed.pathname, baseUrl: "",
      body, params: m ? { id: m[1] } : {}, query, headers,
      get(name: string) { return headers[name.toLowerCase()] ?? headers[name] ?? undefined; }, app, res,
      _parsedUrl: { pathname: parsed.pathname, search: parsed.search, query },
    };
    (app as any).handle(req, res, () => done(404, { error: "not found" }));
  });
}

// ── Pure contract tests ───────────────────────────────────────────────
function shapeChatResponse(r: Record<string, unknown>) {
  return {
    response: r.response, history: r.history, avatar: r.avatar,
    pendingToolCall: (r as any).pendingToolCall,
    taskActions: (r as any).taskActions,
    media: (r as any).media,
    pendingJobs: (r as any).pendingJobs,
    avatarUpdates: (r as any).avatarUpdates,
  };
}
function validateChatBody(b: { message?: string; history?: unknown[] }) {
  const { message, history = [] } = b;
  if (!message && !(history as unknown[]).length) return "message or history required";
  return null;
}

describe("chat response shaping", () => {
  it("forwards all fields including pendingToolCall", () => {
    const body = shapeChatResponse({
      response: "ok", history: [], avatar: { id: "a1" },
      pendingToolCall: { id: "tc-1", name: "configure_integration", arguments: { integration: "telegram" } },
      taskActions: [{ id: "ta-1" }], media: [{ type: "image", url: "x" }],
      pendingJobs: [{ jobId: "j1" }], avatarUpdates: { name: "X" },
    });
    expect(body.pendingToolCall).toBeDefined();
    expect(body.taskActions).toEqual([{ id: "ta-1" }]);
  });
  it("omits absent fields", () => {
    const body = shapeChatResponse({ response: "hi", history: [], avatar: null });
    expect(body.pendingToolCall).toBeUndefined();
  });
  it("rejects empty chat body", () => {
    expect(validateChatBody({})).toMatch(/message or history/);
    expect(validateChatBody({ message: "hi" })).toBeNull();
  });
});

describe("Ascii Box CLI output parsing", () => {
  it("extracts login URLs and next commands from JSON events", async () => {
    const { parseAsciiBoxCliOnboardingOutput } = await import("./ascii-box-provider.js");
    const parsed = parseAsciiBoxCliOnboardingOutput([
      '{"type":"login_url","login_url":"https://ascii.dev/login?token=abc","nextCommand":"box onboard --json"}',
      '{"type":"login_complete","message":"Authenticated"}',
    ].join("\n"));

    expect(parsed.authenticated).toBe(true);
    expect(parsed.loginUrl).toBe("https://ascii.dev/login?token=abc");
    expect(parsed.url).toBe("https://ascii.dev/login?token=abc");
    expect(parsed.nextCommand).toBe("box onboard --json");
  });

  it("falls back to checkout and plain URLs from mixed CLI output", async () => {
    const { parseAsciiBoxCliOnboardingOutput } = await import("./ascii-box-provider.js");
    const parsed = parseAsciiBoxCliOnboardingOutput(
      '{"event":"checkout","checkout_url":"https://checkout.stripe.com/c/pay/test"}\n',
      'Open https://docs.ascii.dev/box/quickstart for help',
    );

    expect(parsed.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/test");
    expect(parsed.url).toBe("https://checkout.stripe.com/c/pay/test");
  });
});

// ── Import resolution tests — catch wrong/broken imports ─────────────
describe("admin-api import resolution", () => {
  beforeAll(async () => {
      await injectTestClients();
  });
  it("processChat is a function from chat.js", async () => {
    const { processChat } = await import("../../admin-api/src/handlers/chat.js");
    expect(typeof processChat).toBe("function");
  });
  it("resumeChatAfterToolResult is a function from chat.js (wrapper with 1 param)", async () => {
    const { resumeChatAfterToolResult } = await import("../../admin-api/src/handlers/chat.js");
    expect(typeof resumeChatAfterToolResult).toBe("function");
    expect(resumeChatAfterToolResult.length).toBe(1);
  });
  it("resumeChatAfterToolResult is a function from resume-chat.js (raw with 2 params)", async () => {
    const { resumeChatAfterToolResult } = await import("../../admin-api/src/handlers/chat-tools/resume-chat.js");
    expect(typeof resumeChatAfterToolResult).toBe("function");
    expect(resumeChatAfterToolResult.length).toBe(2);
  });
});

// ── Route surface + integration tests ─────────────────────────────────
const AID = "test-1";
const originalFetch = globalThis.fetch;
const stubSvc = {
  secrets: {
    setSecret: async () => {},
    flush: async () => {},
    listSecrets: async () => [] as string[],
    getSecret: async (name: string) => name === "llm-api-key" ? "sk-test" : "",
    deleteSecret: async () => {},
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SWARM_LOCAL_API_TOKEN;
  delete process.env.SWARM_LOCAL_ALLOW_CUSTOM_RUNTIME_COMMANDS;
  delete process.env.ASCII_BOX_API_KEY;
  delete process.env.BOX_API_KEY;
  delete process.env.ASCII_BOX_API_BASE;
  delete process.env.BOX_API_BASE;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_ENDPOINT;
  delete process.env.LLM_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SWARM_LOCAL_CHAT;
  delete process.env.SWARM_LOCAL_CHAT_MODEL_PATH;
  delete process.env.SWARM_LOCAL_CHAT_MODEL_URL;
  delete process.env.SWARM_LOCAL_CHAT_MODEL_ID;
  delete process.env.SWARM_LOCAL_CHAT_CONTEXT_SIZE;
  delete process.env.SWARM_LOCAL_EMBEDDINGS;
  delete process.env.SWARM_LOCAL_EMBEDDING_MODEL_PATH;
  delete process.env.SWARM_LOCAL_EMBEDDING_MODEL_URL;
  delete process.env.SWARM_LOCAL_EMBEDDING_MODEL_ID;
  delete process.env.SWARM_LOCAL_EMBEDDING_DIMENSIONS;
  delete process.env.SWARM_HOSTED_MODE_ENABLED;
  delete process.env.SWARM_AWS_HOSTED_ENABLED;
  delete process.env.SWARM_HOSTED_ENTITLEMENT_ACTIVE;
  delete process.env.SWARM_HOSTED_INSTANCE_ENDPOINT;
  delete process.env.SWARM_HOSTED_INSTANCE_ID;
  delete process.env.SWARM_HOSTED_TENANT_ID;
  delete process.env.SWARM_AWS_HOSTED_REGION;
});

describe("mountAdminRoutes integration", () => {
  beforeAll(async () => {
      await injectTestClients();
  });

  it("all expected routes return non-404", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({ response: "hi", history: [], avatar: { id: AID } }) as any);
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/chat", { message: "hi" }],
      ["GET", `/api/chat?avatarId=${AID}`],
      ["DELETE", `/api/chat?avatarId=${AID}`],
      ["POST", "/api/chat/message", { avatarId: AID, message: { role: "assistant", content: "status" } }],
      ["GET", "/api/llm/status"],
      ["POST", "/api/llm/prepare", {}],
      ["GET", "/api/embeddings/status"],
      ["POST", "/api/embeddings/prepare", {}],
      ["GET", "/api/hosting/status"],
      ["POST", "/api/hosting/mode", { mode: "local" }],
      ["POST", "/api/hosting/provision"],
      ["POST", "/api/llm/provider", { provider: "openrouter" }],
      ["DELETE", "/api/llm/provider"],
      ["GET", "/api/agent-backends"],
      ["POST", "/api/agent-backends/select", { backend: "swarm-native" }],
      ["DELETE", "/api/agent-backends/select"],
      ["GET", "/api/compute/ascii-box/status?backend=hermes"],
      ["POST", "/api/compute/ascii-box/provision", { backend: "hermes" }],
      ["GET", "/api/avatars"], ["POST", "/api/avatars", { name: "t" }],
      ["GET", `/api/avatars/${AID}`], ["PUT", `/api/avatars/${AID}`, { name: "x" }],
      ["PATCH", `/api/avatars/${AID}`, { name: "x" }],
      ["POST", `/api/avatars/${AID}/secrets`, { key: "t", value: "x" }],
      ["GET", `/api/avatars/${AID}/secrets`],
      ["POST", `/api/avatars/${AID}/validate-token`, { type: "telegram_bot_token", value: "1".repeat(30) }],
      ["POST", `/api/avatars/${AID}/validate-ai-key`, { integration: "openrouter", value: "sk-xxx" }],
      ["GET", `/api/avatars/${AID}/telegram/diagnose`],
      ["POST", `/api/avatars/${AID}/telegram/repair`],
      ["GET", `/api/avatars/${AID}/integrations`],
      ["POST", `/api/avatars/${AID}/integrations`, {}],
      ["GET", "/api/integrations/models?integration=openrouter"],
      ["POST", `/api/avatars/${AID}/tools/tc-1`, { result: { configured: true } }],
      ["GET", `/api/avatars/${AID}/discord/status`],
    ];
    const results = await Promise.all(routes.map(([m, p, b]) => hitRoute(app, m, p, b).then(r => `${m} ${p} -> ${r.status}`)));
    const bad = results.filter(r => r.endsWith("404"));
    expect(bad).toEqual([]);
  });

  it("does not expose avatar private seed material over HTTP", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);

    const response = await hitRoute(app, "GET", "/api/signal/keypair");

    expect(response.status).toBe(404);
  });

  it("passes pendingToolCall through /api/chat", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({
      response: "ok", history: [], avatar: { id: AID },
      pendingToolCall: { id: "tc-99", name: "configure_integration", arguments: { integration: "discord" } },
      taskActions: [{ id: "ta-1" }], media: [], pendingJobs: [], avatarUpdates: {},
    }) as any);
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "t" });
    expect(status).toBe(200);
    expect((body as any).pendingToolCall.id).toBe("tc-99");
  });

  it("returns 400 on empty chat body", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => ({ response: "x", history: [], avatar: null }) as any);
    expect((await hitRoute(app, "POST", "/api/chat", {})).status).toBe(400);
  });

  it("returns 500 when processChat throws", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any, async () => { throw new Error("boom"); });
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "hi" });
    expect(status).toBe(500);
    expect((body as any).error).toBe("Chat processing failed");
  });

  it("routes chat to the selected external agent backend", async () => {
    const store = new Map<string, string>([
      ["agent:global:agent-backend", "custom"],
      ["agent:global:agent-backend-endpoint", "http://runtime.test/chat"],
      ["agent:global:agent-backend-api-key", "secret"],
    ]);
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => {
          if (!store.has(name)) throw new Error("missing secret");
          return store.get(name);
        },
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    let calledUrl = "";
    let calledBody: any = null;
    let calledAuth = "";
    let calledSignal: AbortSignal | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = JSON.parse(String(init?.body));
      calledAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      calledSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({
        response: "external ok",
        history: [{ role: "assistant", content: "external ok" }],
        avatar: { id: AID },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any, async () => { throw new Error("native chat should not run"); });

    const { status, body } = await hitRoute(app, "POST", "/api/chat", {
      message: "hello",
      history: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(200);
    expect((body as any).response).toBe("external ok");
    expect(calledUrl).toBe("http://runtime.test/chat");
    expect(calledAuth).toBe("Bearer secret");
    expect(calledSignal).toBeInstanceOf(AbortSignal);
    expect(calledBody.backend).toBe("custom");
    expect(calledBody.message).toBe("hello");
  });

  it("blocks native chat when no AI provider is configured", async () => {
    const services = {
      secrets: {
        setSecret: async () => {},
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async () => { throw new Error("missing secret"); },
        deleteSecret: async () => {},
      },
    };
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any, async () => ({ response: "x", history: [], avatar: null }) as any);
    const { status, body } = await hitRoute(app, "POST", "/api/chat", { message: "hi" });
    expect(status).toBe(409);
    expect((body as any).code).toBe("AI_PROVIDER_REQUIRED");
  });

  it("guards writes with trusted origins or the per-launch token", async () => {
    const { isAllowedLocalOrigin, isLocalApiWriteAllowed } = await import("./server.js");
    expect(isAllowedLocalOrigin(undefined, 3001)).toBe(false);
    expect(isAllowedLocalOrigin("http://localhost:3001", 3001)).toBe(true);
    expect(isAllowedLocalOrigin("http://127.0.0.1:3001", 3001)).toBe(true);
    expect(isAllowedLocalOrigin("https://evil.example", 3001)).toBe(false);

    const cases = [
      { label: "read without origin", method: "GET", allowed: true },
      { label: "trusted localhost write", method: "POST", origin: "http://localhost:3001", allowed: true },
      { label: "trusted loopback write", method: "DELETE", origin: "http://127.0.0.1:3001", allowed: true },
      { label: "hostile origin write", method: "PATCH", origin: "https://evil.example", allowed: false },
      { label: "missing origin write", method: "PUT", allowed: false },
      { label: "missing origin with invalid token", method: "POST", expectedToken: "token", providedToken: "wrong", allowed: false },
      { label: "trusted origin with missing configured token", method: "POST", origin: "http://localhost:3001", expectedToken: "token", allowed: false },
      { label: "hostile origin with valid token", method: "POST", origin: "https://evil.example", expectedToken: "token", providedToken: "token", allowed: true },
      { label: "missing origin with valid token", method: "POST", expectedToken: "token", providedToken: "token", allowed: true },
    ];

    for (const testCase of cases) {
      expect(isLocalApiWriteAllowed({
        method: testCase.method,
        origin: testCase.origin,
        providedToken: testCase.providedToken,
        expectedToken: testCase.expectedToken,
        port: 3001,
      }), testCase.label).toBe(testCase.allowed);
    }
  });

  it("allows only exact built-in runtime launch commands", async () => {
    const { isAllowedRuntimeLaunchCommand } = await import("./server.js");

    expect(isAllowedRuntimeLaunchCommand("hermes", "hermes proxy start --port 8645")).toBe(true);
    expect(isAllowedRuntimeLaunchCommand(
      "hermes",
      "docker run --rm --name swarm-rt-hermes -p 8645:8645 your-hermes-image proxy start --host 0.0.0.0 --port 8645",
    )).toBe(true);
    expect(isAllowedRuntimeLaunchCommand("hermes", "hermes proxy start --port 8645; touch /tmp/swarm-pwned")).toBe(false);
    expect(isAllowedRuntimeLaunchCommand("custom", "touch /tmp/swarm-pwned")).toBe(false);
  });

  it("authorizes custom runtime commands only with explicit opt-in and the launch token", async () => {
    const { isAuthorizedCustomRuntimeCommand } = await import("./server.js");
    const request = (providedToken?: string) => ({
      get: (name: string) => name.toLowerCase() === "x-swarm-local-token" ? providedToken : undefined,
    }) as any;

    process.env.SWARM_LOCAL_API_TOKEN = "token";
    expect(isAuthorizedCustomRuntimeCommand(request("token"))).toBe(false);

    process.env.SWARM_LOCAL_ALLOW_CUSTOM_RUNTIME_COMMANDS = "1";
    expect(isAuthorizedCustomRuntimeCommand(request())).toBe(false);
    expect(isAuthorizedCustomRuntimeCommand(request("wrong"))).toBe(false);
    expect(isAuthorizedCustomRuntimeCommand(request("token"))).toBe(true);

    delete process.env.SWARM_LOCAL_API_TOKEN;
    expect(isAuthorizedCustomRuntimeCommand(request("token"))).toBe(false);
  });

  it("rejects arbitrary runtime launch commands at the route", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const { status, body } = await hitRoute(app, "POST", "/api/runtime/start", {
      backend: "custom",
      command: "touch /tmp/swarm-pwned",
    });
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/known runtime template/);
  });

  it("requires the local token before returning runtime logs when configured", async () => {
    process.env.SWARM_LOCAL_API_TOKEN = "token";
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const blocked = await hitRoute(app, "GET", "/api/runtime/logs?backend=hermes");
    expect(blocked.status).toBe(403);
    const allowed = await hitRoute(
      app,
      "GET",
      "/api/runtime/logs?backend=hermes",
      undefined,
      { "x-swarm-local-token": "token" },
    );
    expect(allowed.status).toBe(200);
  });

  it("reads legacy global backend secrets during upgrade", async () => {
    const store = new Map<string, string>([
      ["agent-backend", "custom"],
      ["agent-backend-endpoint", "http://legacy-runtime.test/chat"],
    ]);
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => {
          if (!store.has(name)) throw new Error("missing secret");
          return store.get(name);
        },
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any);
    const { status, body } = await hitRoute(app, "GET", "/api/agent-backends");
    expect(status).toBe(200);
    expect((body as any).selected).toBe("custom");
    expect((body as any).endpoint).toBe("http://legacy-runtime.test/chat");
  });

  it("namespaces runtime secrets and limits legacy fallback to the global scope", async () => {
    const {
      agentRuntimeSecretKey,
      legacyAgentRuntimeSecretKey,
      legacyRuntimeSecretKey,
      mountAdminRoutes,
      runtimeSecretKey,
    } = await import("./server.js");

    expect(agentRuntimeSecretKey("agent-backend", "avatar-one")).toBe("agent:avatar-one:agent-backend");
    expect(agentRuntimeSecretKey("agent-backend")).toBe("agent:global:agent-backend");
    expect(legacyAgentRuntimeSecretKey("agent-backend", "avatar-one")).toBe("agent:avatar-one:agent-backend");
    expect(legacyAgentRuntimeSecretKey("agent-backend")).toBe("agent-backend");
    expect(runtimeSecretKey("launch", "hermes", "avatar-one")).toBe("runtime:avatar-one:hermes:launch");
    expect(runtimeSecretKey("launch", "hermes")).toBe("runtime:global:hermes:launch");
    expect(legacyRuntimeSecretKey("launch", "hermes", "avatar-one")).toBe("runtime:avatar-one:hermes:launch");
    expect(legacyRuntimeSecretKey("launch", "hermes")).toBe("runtime-launch:hermes");

    const store = new Map<string, string>([
      ["runtime-launch:hermes", "legacy-global-command"],
      ["runtime-endpoint:hermes", "http://legacy-global.test"],
      ["runtime:avatar-one:hermes:launch", "avatar-one-command"],
      ["runtime:avatar-one:hermes:endpoint", "http://avatar-one.test"],
      ["runtime:avatar-two:hermes:launch", "avatar-two-command"],
      ["runtime:avatar-two:hermes:endpoint", "http://avatar-two.test"],
    ]);
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => {
          if (!store.has(name)) throw new Error("missing secret");
          return store.get(name);
        },
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    const app = express();
    await mountAdminRoutes(app, services as any);

    const legacyGlobal = await hitRoute(app, "GET", "/api/runtime/status?backend=hermes");
    expect((legacyGlobal.body as any).command).toBe("legacy-global-command");
    expect((legacyGlobal.body as any).endpoint).toBe("http://legacy-global.test");

    store.set("runtime:global:hermes:launch", "current-global-command");
    store.set("runtime:global:hermes:endpoint", "http://current-global.test");
    const currentGlobal = await hitRoute(app, "GET", "/api/runtime/status?backend=hermes");
    expect((currentGlobal.body as any).command).toBe("current-global-command");
    expect((currentGlobal.body as any).endpoint).toBe("http://current-global.test");

    const avatarOne = await hitRoute(app, "GET", "/api/runtime/status?backend=hermes&avatarId=avatar-one");
    expect((avatarOne.body as any).command).toBe("avatar-one-command");
    expect((avatarOne.body as any).endpoint).toBe("http://avatar-one.test");

    const avatarTwo = await hitRoute(app, "GET", "/api/runtime/status?backend=hermes&avatarId=avatar-two");
    expect((avatarTwo.body as any).command).toBe("avatar-two-command");
    expect((avatarTwo.body as any).endpoint).toBe("http://avatar-two.test");

    const unconfiguredAvatar = await hitRoute(app, "GET", "/api/runtime/status?backend=hermes&avatarId=avatar-three");
    expect((unconfiguredAvatar.body as any).command).toBe("hermes proxy start --port 8645");
    expect((unconfiguredAvatar.body as any).endpoint).toBe("http://localhost:8645");
  });

  it("reports hosted service only after entitlement and runtime health are authoritative", async () => {
    const store = new Map<string, string>();
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => store.get(name) ?? (name === "llm-api-key" ? "sk-test" : ""),
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any);

    const status = await hitRoute(app, "GET", "/api/hosting/status");
    expect(status.status).toBe(200);
    expect((status.body as any).mode).toBe("local");
    expect((status.body as any).local.available).toBe(true);
    expect((status.body as any).hosted.provider).toBe("aws");
    expect((status.body as any).hosted.architecture).toBe("aws-managed-ec2-pool");
    expect((status.body as any).hosted.priceUsdMonthly).toBe(9);
    expect((status.body as any).hosted.plan.id).toBe("starter");
    expect((status.body as any).hosted.available).toBe(false);
    expect((status.body as any).hosted.entitlement).toBe("none");
    expect((status.body as any).hosted.status).toBe("not-configured");
    expect(String((status.body as any).hosted.detail).includes("AWS")).toBe(false);
    expect(String((status.body as any).hosted.detail).includes("EC2")).toBe(false);

    const local = await hitRoute(app, "POST", "/api/hosting/mode", { mode: "local" });
    expect(local.status).toBe(200);
    expect((local.body as any).mode).toBe("local");

    const hosted = await hitRoute(app, "POST", "/api/hosting/mode", { mode: "hosted" });
    expect(hosted.status).toBe(501);
    expect((hosted.body as any).status.mode).toBe("local");
    expect((hosted.body as any).status.hosted.entitlement).toBe("none");
    expect(store.get("hosting:global:mode")).toBe("local");
    expect(store.has("hosting:global:aws-managed-instance")).toBe(false);

    const provisioned = await hitRoute(app, "POST", "/api/hosting/provision");
    expect(provisioned.status).toBe(501);
    expect((provisioned.body as any).status.mode).toBe("local");

    process.env.SWARM_HOSTED_ENTITLEMENT_ACTIVE = "1";
    process.env.SWARM_HOSTED_INSTANCE_ENDPOINT = "https://tenant-1.swarm.example";
    process.env.SWARM_HOSTED_INSTANCE_ID = "i-test123";
    process.env.SWARM_HOSTED_TENANT_ID = "tenant-1";
    store.set("hosting:global:mode", "hosted");
    store.set("hosting:global:aws-managed-instance", JSON.stringify({
      provider: "aws",
      architecture: "aws-managed-ec2-pool",
      planId: "starter",
      status: "running",
      requestedAt: Date.now() - 10_000,
      updatedAt: Date.now(),
      instanceId: "i-placeholder",
      endpoint: "https://placeholder.swarm.example",
    }));
    const active = await hitRoute(app, "GET", "/api/hosting/status");
    expect((active.body as any).mode).toBe("local");
    expect((active.body as any).hosted.status).toBe("not-configured");
    expect((active.body as any).hosted.entitlement).toBe("none");
    expect((active.body as any).hosted.billing.status).toBe("eligible");
    expect((active.body as any).hosted.runtime.status).toBe("stopped");
    expect((active.body as any).hosted.modelWorkAllowed).toBe(false);
    expect((active.body as any).hosted.instance).toBeUndefined();
    expect(store.has("hosting:global:aws-managed-instance")).toBe(true);
  });

  it("reports auto-detected Ollama as the active provider without a saved provider secret", async () => {
    process.env.LLM_API_KEY = "ollama";
    process.env.LLM_ENDPOINT = "http://localhost:11434/v1";
    process.env.LLM_MODEL = "smolLm2";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/tags") {
        return new Response(JSON.stringify({
          models: [{ name: "smolLm2:latest", size: 1 }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const services = {
      secrets: {
        setSecret: async () => {},
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async () => "",
        deleteSecret: async () => {},
      },
    };
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any);

    const status = await hitRoute(app, "GET", "/api/llm/status");

    expect(status.status).toBe(200);
    expect((status.body as any).configured).toBe(true);
    expect((status.body as any).provider).toBe("ollama");
    expect((status.body as any).selectedProvider).toBe("ollama");
    expect((status.body as any).ollama.model).toBe("smolLm2");
  });

  it("reports embedded llama.cpp chat and serves OpenAI-compatible completions", async () => {
    const services = {
      secrets: {
        setSecret: async () => {},
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async () => { throw new Error("missing secret"); },
        deleteSecret: async () => {},
      },
    };
    const chatService = {
      modelId: "local-chat-test",
      status: async (_checkPackage?: boolean, endpoint = "") => ({
        provider: "llama.cpp" as const,
        enabled: true,
        ready: true,
        packageAvailable: true,
        modelExists: true,
        modelPath: "/tmp/local-chat-test.gguf",
        modelId: "local-chat-test",
        contextSize: 4096,
        downloadUrl: "https://example.test/model.gguf",
        endpoint,
      }),
      prepare: async () => ({
        provider: "llama.cpp" as const,
        enabled: true,
        ready: true,
        packageAvailable: true,
        modelExists: true,
        modelPath: "/tmp/local-chat-test.gguf",
        modelId: "local-chat-test",
        contextSize: 4096,
        downloadUrl: "https://example.test/model.gguf",
        endpoint: "http://127.0.0.1:3001/v1",
        sampleResponse: "ready",
      }),
      complete: async (body: any) => ({
        id: "chatcmpl-local-test",
        object: "chat.completion" as const,
        created: 0,
        model: body.model || "local-chat-test",
        choices: [{
          index: 0,
          message: { role: "assistant" as const, content: "inside" },
          finish_reason: "stop" as const,
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };

    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(
      app,
      services as any,
      async () => ({ response: "x", history: [], avatar: null }) as any,
      undefined,
      chatService as any,
      "http://127.0.0.1:3001/v1",
    );

    const status = await hitRoute(app, "GET", "/api/llm/status");
    expect(status.status).toBe(200);
    expect((status.body as any).configured).toBe(true);
    expect((status.body as any).provider).toBe("embedded");
    expect((status.body as any).embedded.ready).toBe(true);

    const completion = await hitRoute(app, "POST", "/v1/chat/completions", {
      model: "local-chat-test",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    expect(completion.status).toBe(200);
    expect((completion.body as any).choices[0].message.content).toBe("inside");

    const prepared = await hitRoute(app, "POST", "/api/llm/prepare", {});
    expect(prepared.status).toBe(200);
    expect((prepared.body as any).sampleResponse).toBe("ready");
  });

  it("exposes disabled embedded embedding status when no local embedder is injected", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);

    const status = await hitRoute(app, "GET", "/api/embeddings/status");
    expect(status.status).toBe(200);
    expect((status.body as any).provider).toBe("llama.cpp");
    expect((status.body as any).enabled).toBe(false);

    const prepared = await hitRoute(app, "POST", "/api/embeddings/prepare", {});
    expect(prepared.status).toBe(409);
  });

  it("provisions Ascii Box sessions and redacts provider URLs in client payloads", async () => {
    process.env.ASCII_BOX_API_KEY = "box_test";
    const store = new Map<string, string>();
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => store.get(name) ?? (name === "llm-api-key" ? "sk-test" : ""),
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    const commands: string[] = [];
    const requests: Array<{ method: string; path: string; auth: string; body?: any }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? "GET";
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path: parsed.pathname, auth, body });

      if (method === "POST" && parsed.pathname.endsWith("/boxes")) {
        return new Response(JSON.stringify({
          ok: true,
          box: {
            id: "box_test_123456789012",
            state: "provisioning",
            desktopUrl: "https://desktop.ascii.dev/session?_token=super-secret",
          },
        }), { status: 200 });
      }

      if (method === "GET" && parsed.pathname.endsWith("/boxes/box_test_123456789012")) {
        return new Response(JSON.stringify({
          ok: true,
          box: {
            id: "box_test_123456789012",
            state: "ready",
            desktopUrl: "https://desktop.ascii.dev/session?_token=super-secret",
          },
        }), { status: 200 });
      }

      if (method === "POST" && parsed.pathname.endsWith("/boxes/box_test_123456789012/commands")) {
        commands.push(String(body.command));
        const stdout = String(body.command).startsWith("host ")
          ? "https://box-host.ascii.dev?_token=runtime-secret\n"
          : "started\n";
        return new Response(JSON.stringify({ ok: true, exitCode: 0, stdout }), { status: 200 });
      }

      return new Response(JSON.stringify({ error: { message: "unexpected request" } }), { status: 500 });
    }) as typeof fetch;

    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any);

    const provisioned = await hitRoute(app, "POST", "/api/compute/ascii-box/provision", {
      backend: "hermes",
      ttlSeconds: 1800,
      noEnv: true,
    });

    expect(provisioned.status).toBe(202);
    expect((provisioned.body as any).provider).toBe("ascii-box");
    expect((provisioned.body as any).configured).toBe(true);
    expect((provisioned.body as any).box.desktopUrl).toContain("_token=%5BREDACTED%5D");
    expect(store.get("agent:global:agent-backend")).toBe("hermes");
    expect(store.get("agent:global:agent-backend-deployment-target")).toBe("ascii-box");

    const status = await hitRoute(app, "GET", "/api/compute/ascii-box/status?backend=hermes");
    expect(status.status).toBe(200);
    expect((status.body as any).endpoint).toContain("_token=%5BREDACTED%5D");
    expect((status.body as any).session.endpoint).toContain("_token=%5BREDACTED%5D");
    expect(JSON.stringify(status.body)).not.toContain("runtime-secret");
    expect((status.body as any).box.desktopUrl).toContain("_token=%5BREDACTED%5D");
    expect(store.get("agent:global:agent-backend-endpoint")).toBe("https://box-host.ascii.dev?_token=runtime-secret");
    const agentStatus = await hitRoute(app, "GET", "/api/agent-backends");
    expect((agentStatus.body as any).endpoint).toContain("_token=%5BREDACTED%5D");
    expect(JSON.stringify(agentStatus.body)).not.toContain("runtime-secret");
    expect(commands.some((command) => command.includes("hermes proxy start --host 0.0.0.0 --port 8645"))).toBe(true);
    expect(commands).toContain("host 8645 --title 'Swarm Hermes'");
    expect(requests.every((request) => request.auth === "Bearer box_test")).toBe(true);
    expect(requests.find((request) => request.method === "POST" && request.path.endsWith("/boxes"))?.body).toEqual({
      ttlSeconds: 1800,
      noEnv: true,
    });
  });

  it("secret save works", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const { status } = await hitRoute(app, "POST", `/api/avatars/${AID}/secrets`, { key: "t", value: "x" });
    expect(status).toBe(200);
  });

  it("tools resume route exists and returns non-404", async () => {
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, stubSvc as any);
    const { status } = await hitRoute(app, "POST", `/api/avatars/${AID}/tools/tc-1`, { result: { ok: true } });
    // Route exists (not 404); internal store may not be initialized so error varies
    expect(status).not.toBe(404);
  });

  it("lists and selects local agent backends", async () => {
    const store = new Map<string, string>();
    const services = {
      secrets: {
        setSecret: async (name: string, value: string) => { store.set(name, value); },
        flush: async () => {},
        listSecrets: async () => [] as string[],
        getSecret: async (name: string) => store.get(name) ?? (name === "llm-api-key" ? "sk-test" : ""),
        deleteSecret: async (name: string) => { store.delete(name); },
      },
    };
    const { mountAdminRoutes } = await import("./server.js");
    const app = express();
    await mountAdminRoutes(app, services as any);

    const initial = await hitRoute(app, "GET", "/api/agent-backends");
    expect(initial.status).toBe(200);
    expect((initial.body as any).selected).toBe("swarm-native");
    expect((initial.body as any).backends.some((backend: any) => backend.id === "elizaos")).toBe(true);
    expect((initial.body as any).backends.some((backend: any) => backend.id === "codex")).toBe(true);
    expect((initial.body as any).backends.some((backend: any) => backend.id === "cosyworld")).toBe(true);
    const hermes = (initial.body as any).backends.find((backend: any) => backend.id === "hermes");
    const openclaw = (initial.body as any).backends.find((backend: any) => backend.id === "openclaw");
    const cosyworld = (initial.body as any).backends.find((backend: any) => backend.id === "cosyworld");
    expect(hermes.install.commands.some((command: string) => command.includes("hermes setup"))).toBe(true);
    expect(openclaw.install.docsUrl).toBe("https://docs.openclaw.ai/install");
    expect(cosyworld.launch.endpoint).toBe("http://localhost:3101");

    const missingEndpoint = await hitRoute(app, "POST", "/api/agent-backends/select", { backend: "custom" });
    expect(missingEndpoint.status).toBe(400);

    const defaulted = await hitRoute(app, "POST", "/api/agent-backends/select", { backend: "openclaw" });
    expect(defaulted.status).toBe(200);
    expect((defaulted.body as any).selected).toBe("openclaw");
    expect((defaulted.body as any).endpoint).toBe("http://localhost:8787");

    const selected = await hitRoute(app, "POST", "/api/agent-backends/select", {
      backend: "openclaw",
      endpoint: "http://localhost:7331",
      apiKey: "secret",
    });
    expect(selected.status).toBe(200);
    expect((selected.body as any).selected).toBe("openclaw");
    expect((selected.body as any).endpoint).toBe("http://localhost:7331");
    expect((selected.body as any).hasApiKey).toBe(true);
    expect(store.get("agent:global:agent-backend-api-key")).toBe("secret");

    const codex = await hitRoute(app, "POST", "/api/agent-backends/select", { backend: "codex" });
    expect(codex.status).toBe(200);
    expect((codex.body as any).selected).toBe("codex");
    expect((codex.body as any).hasApiKey).toBe(false);
    expect(store.has("agent:global:agent-backend-api-key")).toBe(false);

    const scoped = await hitRoute(app, "POST", "/api/agent-backends/select", {
      avatarId: "avatar-one",
      backend: "cosyworld",
    });
    expect(scoped.status).toBe(200);
    expect((scoped.body as any).scope.avatarId).toBe("avatar-one");
    expect((scoped.body as any).selected).toBe("cosyworld");
    expect((scoped.body as any).endpoint).toBe("http://localhost:3101");
    expect(store.get("agent:avatar-one:agent-backend")).toBe("cosyworld");
    expect(store.get("agent:global:agent-backend")).toBe("codex");

    const asciiBox = await hitRoute(app, "POST", "/api/agent-backends/select", {
      avatarId: "avatar-one",
      backend: "cosyworld",
      deploymentTarget: "ascii-box",
    });
    expect(asciiBox.status).toBe(200);
    expect((asciiBox.body as any).deploymentTarget).toBe("ascii-box");
    expect((asciiBox.body as any).endpoint).toBeUndefined();
    expect((asciiBox.body as any).compute.asciiBox.configured).toBe(false);

    const rejectedLegacyTarget = await hitRoute(app, "POST", "/api/agent-backends/select", {
      avatarId: "avatar-one",
      backend: "cosyworld",
      deploymentTarget: "fly",
    });
    expect(rejectedLegacyTarget.status).toBe(400);
    expect((rejectedLegacyTarget.body as any).error).toMatch(/ascii-box/);

    const reset = await hitRoute(app, "DELETE", "/api/agent-backends/select");
    expect(reset.status).toBe(200);
    expect((reset.body as any).selected).toBe("swarm-native");

    const scopedReset = await hitRoute(app, "DELETE", "/api/agent-backends/select?avatarId=avatar-one");
    expect(scopedReset.status).toBe(200);
    expect((scopedReset.body as any).selected).toBe("swarm-native");
    expect(store.has("agent:avatar-one:agent-backend")).toBe(false);
  });
});
