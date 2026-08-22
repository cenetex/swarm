/**
 * Raticross protocol type tests.
 */
import { describe, it, expect } from "bun:test";
import type {
  RaticrossActor,
  RaticrossEnvelope,
  RaticrossHealthRequest,
  RaticrossHealthResponse,
  RaticrossBridgeConfig,
  RaticrossSendResult,
} from "../types/raticross.js";

describe("Raticross Protocol Types", () => {
  it("RaticrossEnvelope satisfies the wire format contract", () => {
    const envelope: RaticrossEnvelope = {
      id: "msg-001",
      traceId: "trace-abc",
      protocol: "0.1",
      timestamp: Date.now(),
      from: { system: "swarm", agentId: "avatar-1", pubkey: "abc123" },
      to: { system: "kyro", agentId: "kyro-bot", pubkey: "def456" },
      type: "message",
      conversationId: "conv-42",
      content: "hello",
      context: { priority: "normal", expiresAt: Date.now() + 60000 },
    };

    expect(envelope.id).toBe("msg-001");
    expect(envelope.from.system).toBe("swarm");
    expect(envelope.from.agentId).toBe("avatar-1");
    expect(envelope.from.pubkey).toBe("abc123");
    expect(envelope.to.pubkey).toBe("def456");
    expect(envelope.type).toBe("message");
    expect(envelope.content).toBe("hello");
    expect(envelope.context?.priority).toBe("normal");
  });

  it("RaticrossEnvelope works with minimal fields", () => {
    const minimal: RaticrossEnvelope = {
      id: "m1",
      timestamp: 1700000000000,
      from: { system: "swarm", agentId: "a1", pubkey: "pk1" },
      to: { system: "kyro", agentId: "k1", pubkey: "pk2" },
      type: "message",
      conversationId: "c1",
      content: "hi",
    };
    expect(minimal.id).toBe("m1");
    expect(minimal.content).toBe("hi");
  });

  it("RaticrossEnvelope supports all message types", () => {
    const types: RaticrossEnvelope["type"][] = ["message", "task", "result", "status"];
    for (const type of types) {
      const env: RaticrossEnvelope = {
        id: "1",
        timestamp: 0,
        from: { system: "swarm", agentId: "a", pubkey: "pk" },
        to: { system: "kyro", agentId: "b", pubkey: "pk2" },
        type,
        conversationId: "c",
        content: "",
      };
      expect(env.type).toBe(type);
    }
  });

  it("RaticrossActor requires pubkey", () => {
    const actor: RaticrossActor = {
      system: "swarm",
      agentId: "avatar-1",
      pubkey: "abc123",
    };
    expect(typeof actor.pubkey).toBe("string");
    expect(actor.pubkey).toBe("abc123");
  });

  it("RaticrossHealthRequest has required fields", () => {
    const req: RaticrossHealthRequest = {
      type: "health",
      timestamp: Date.now(),
      from: { system: "swarm", agentId: "probe" },
    };
    expect(req.type).toBe("health");
  });

  it("RaticrossHealthResponse represents healthy and unhealthy states", () => {
    const healthy: RaticrossHealthResponse = {
      status: "healthy",
      timestamp: Date.now(),
      relayVersion: "0.1.0",
    };
    expect(healthy.status).toBe("healthy");

    const unhealthy: RaticrossHealthResponse = {
      status: "unhealthy",
      timestamp: Date.now(),
      error: "relay_down",
    };
    expect(unhealthy.status).toBe("unhealthy");
  });

  it("RaticrossBridgeConfig has sensible defaults documented", () => {
    const config: RaticrossBridgeConfig = {
      relayUrl: "http://localhost:9876",
    };
    expect(config.relayUrl).toBe("http://localhost:9876");
  });

  it("RaticrossSendResult represents success and failure", () => {
    const success: RaticrossSendResult = { success: true };
    expect(success.success).toBe(true);

    const failure: RaticrossSendResult = {
      success: false,
      error: "timeout",
    };
    expect(failure.success).toBe(false);
    expect(failure.error).toBe("timeout");
  });
});
