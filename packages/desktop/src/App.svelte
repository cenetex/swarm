<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";

  let state: "locked" | "unlocking" | "first-run" | "running" | "error" = $state("locked");
  let password = $state("");
  let confirm = $state("");
  let error = $state("");
  let serverUrl = $state("");
  let localToken = $state("");
  let iframeEl = $state<HTMLIFrameElement>();

  // Intercept iframe navigation to /api/auth/openrouter
  function handleIframeLoad() {
    if (!iframeEl) return;
    try {
      const doc = iframeEl.contentDocument || iframeEl.contentWindow?.document;
      if (!doc) return;
      // Override links/buttons that target openrouter auth
      doc.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const link = target.closest("[data-action='openrouter-connect']");
        if (link) {
          e.preventDefault();
          e.stopPropagation();
          startOpenRouterAuth();
        }
      });
    } catch {
      // cross-origin, can't access iframe content
    }
  }

  async function startOpenRouterAuth() {
    try {
      // Request the PKCE URL from the server
      const resp = await fetch(`${serverUrl}/api/auth/openrouter`, {
        redirect: "manual",
        headers: localToken ? { "x-swarm-local-token": localToken } : {},
      });
      const html = await resp.text();
      // Extract the OpenRouter URL from the redirect script
      const match = html.match(/window\.top\.location\.href = "(https:\/\/openrouter\.ai\/auth[^"]+)"/);
      if (match) {
        invoke("open_url", { url: match[1] });
      }
    } catch (e) {
      console.error("Failed to start OpenRouter auth:", e);
    }
  }

  // Listen for postMessage from admin UI iframe
  $effect(() => {
    if (state !== "running") return;
    const handler = (event: MessageEvent) => {
      if (event.data?.action === "openrouter-connect") {
        startOpenRouterAuth();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!password) return;

    if (state === "first-run") {
      if (password.length < 8) { error = "Password must be at least 8 characters."; return; }
      if (password !== confirm) { error = "Passwords do not match."; return; }
    }

    state = "unlocking";
    error = "";

    try {
      const result = await invoke<{ url: string; token: string }>("start_server", { password });
      serverUrl = result.url;
      localToken = result.token;
      state = "running";
    } catch (e: any) {
      error = typeof e === "string" ? e : e?.message ?? "Failed to start server";
      state = state === "unlocking" ? "locked" : state;
    }
  }
</script>

<div class="container">
  {#if state === "locked" || state === "first-run" || state === "unlocking"}
    <div class="auth">
      <div class="logo">🐝</div>
      <h1>Swarm</h1>
      <p class="subtitle">Local-first AI avatar platform</p>

      <form onsubmit={handleSubmit}>
        <input type="password" bind:value={password}
          placeholder={state === "first-run" ? "Choose admin password" : "Admin password"}
          disabled={state === "unlocking"} />

        {#if state === "first-run"}
          <input type="password" bind:value={confirm}
            placeholder="Confirm password" disabled={state === "unlocking"} />
        {/if}

        <button type="submit" disabled={state === "unlocking" || !password}>
          {state === "unlocking" ? "Unlocking..." : state === "first-run" ? "Create & Start" : "Unlock"}
        </button>

        {#if error}<p class="error">{error}</p>{/if}
      </form>

      <p class="hint">
        {state === "first-run" ? "First run — choose a password to encrypt your secrets." : "Enter your password to unlock the swarm."}
      </p>
    </div>

  {:else if state === "running" && serverUrl}
    <iframe
      bind:this={iframeEl}
      src={`${serverUrl}?swarmLocalToken=${encodeURIComponent(localToken)}`}
      class="admin-frame"
      title="Swarm Admin"
      onload={handleIframeLoad}
    ></iframe>

  {:else if state === "error"}
    <div class="auth">
      <h1>Error</h1>
      <p class="error">{error}</p>
      <button onclick={() => { state = "locked"; error = ""; }}>Retry</button>
    </div>
  {/if}
</div>

<style>
  .container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #0d0d0d; }
  .auth { text-align: center; max-width: 360px; width: 100%; padding: 40px 32px; }
  .logo { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 4px; color: #f0f0f0; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 28px; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input { padding: 10px 14px; border-radius: 6px; border: 1px solid #333; background: #1a1a1a; color: #e0e0e0; font-size: 14px; outline: none; }
  input:focus { border-color: #d4a030; }
  input:disabled { opacity: 0.5; }
  button { padding: 10px 14px; border-radius: 6px; border: none; background: #d4a030; color: #0d0d0d; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover:not(:disabled) { opacity: 0.9; }
  button:disabled { opacity: 0.4; cursor: default; }
  .error { color: #e05555; font-size: 13px; margin-top: 4px; }
  .hint { font-size: 12px; color: #555; margin-top: 20px; line-height: 1.5; }
  .admin-frame { width: 100%; height: 100%; border: none; background: #fff; }
</style>
