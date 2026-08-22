# Hosted Runtimes On Ascii Box

Ascii Box is the supported cloud compute provider for one-click agent runtime provisioning from the native/local Swarm server.

## Server Configuration

Set one of these secrets or environment variables on the local server:

- `ASCII_BOX_API_KEY`
- `BOX_API_KEY`

Optional API override for development:

- `ASCII_BOX_API_BASE`
- `BOX_API_BASE`

The server sends provider credentials only from the server side. The admin UI can request provisioning, status, stop, resume, and delete actions, but it never receives the Box API key.

## User Flow

1. Open the advanced runtime settings.
2. Pick a runtime such as Hermes, ElizaOS, or CosyWorld.
3. Select `Ascii Box`.
4. Click `Provision`.
5. Swarm creates a Box, starts the runtime command, attaches the runtime port with `host`, and saves the resulting endpoint automatically.

No endpoint copy and paste is required. If the Box is still provisioning, the UI polls status until the endpoint is available.

## Provider Behavior

- New boxes default to `noEnv: true`.
- New boxes default to a one-hour TTL unless a shorter TTL is provided by the caller.
- Desktop URLs returned by the provider are redacted before they are sent to the UI.
- Hosted runtime endpoints are stored in the same scoped backend endpoint secret used by local runtimes.
- Deleting a session also clears the selected backend endpoint for that scope.

## Supported Runtime Shape

A runtime can be provisioned when its backend definition has:

- a launch command
- a local endpoint with a parseable port
- an Ascii Box endpoint hint for the UI
- a Box launch command that binds the service to `0.0.0.0`

The current provider starts the launch command in the background and then runs:

```bash
host <port> --title <runtime name>
```

The first URL in that command output becomes the saved runtime endpoint.

Ascii hosted URLs cannot reach services bound only to `localhost` or `127.0.0.1`, so provider-specific runtime commands should prefer explicit host flags or `HOST=0.0.0.0`.
