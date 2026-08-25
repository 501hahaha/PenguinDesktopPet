# Agent Bridge authentication

The local Agent Bridge requires a per-user authentication handshake before it
accepts lifecycle events or Companion Bridge endpoint frames.

On first launch the desktop pet creates `agent-bridge-token` inside Electron's
`app.getPath("userData")` directory. Child processes started by the desktop pet
inherit `PENGUIN_AGENT_BRIDGE_TOKEN_FILE`. The token file is included in managed
data deletion and is never exposed through renderer IPC or written to event
logs.

External hooks and already-running hosts must receive the same environment
variable explicitly. Resolve the user-data directory from the running app, then
set:

```text
PENGUIN_AGENT_BRIDGE_TOKEN_FILE=<Electron userData>/agent-bridge-token
```

`PENGUIN_AGENT_BRIDGE_TOKEN` is also supported for short-lived test processes.
The first NDJSON frame on every connection must be:

```json
{"type":"auth","token":"<bridge token>"}
```

Only after an acknowledgement with `{"ok":true,"authenticated":true}` may
the client send endpoint registration or lifecycle event frames. The bundled
`scripts/agent-event-bridge.mjs`, Codex adapter, and Claude hook perform this
handshake automatically. Missing or invalid credentials are rejected without
publishing an event.

## Endpoint identity and routing

Endpoint registration is in-memory and authenticated through the same local bridge. Dispatch and follow-up frames are routed only to the socket that registered the target `endpointId`; a disconnected socket is removed from the routing map. Follow-up delivery requires the endpoint to advertise `input`; observation-only endpoints remain read-only.
