# ChatGPT Control integration

This fork exposes the minimum CodexPro-side primitives needed to correlate a ChatGPT conversation with the CodexPro tool activity produced by that conversation and to feed a separate Threads monitoring UI.

The integration is deliberately split across repositories:

- **CodexPro** owns request correlation, bounded observability, and the opaque binding marker added to MCP tool results.
- **ChatGPT Control** owns browser/sidebar discovery, marker matching, persistent `fingerprint -> thread_id` bindings, recovery supervision, and the Threads collector.
- The **Threads WebUI** is a read-only presentation layer fed by ChatGPT Control collectors. It is not part of CodexPro request execution.

## Data flow

```text
ChatGPT conversation
    |
    | MCP tool call
    v
CodexPro
    |-- captures x-openai-session-fingerprint
    |-- records correlated request/tool/session telemetry
    |-- adds codexpro_binding_marker = cpb1_<24 hex> to structuredContent
    |
    v
ChatGPT tool turn stores the same opaque marker
    |
    v
ChatGPT Control
    |-- reads visible/recent thread candidates
    |-- finds an exact cpb1 marker match
    |-- persists fingerprint -> thread_id
    |-- supervises active bound threads
    |
    v
collector -> Threads WebUI
```

## Stable correlation fields

CodexPro captures per-request correlation with `AsyncLocalStorage` and carries it through tool execution.

The stable bridge key used by ChatGPT Control is:

```text
clientCorrelation["x-openai-session-fingerprint"]
```

Do **not** treat these as durable conversation identity:

- MCP session ID
- JSON-RPC request ID
- CodexPro request ID
- tool call ID

Those values are useful for tracing one request or one server session only.

## Opaque binding marker

For a valid hexadecimal client-session fingerprint, CodexPro normalizes the value to the first 12 lowercase hex characters and derives:

```text
cpb1_<first 24 hex chars of SHA-256("codexpro-binding-v1:" + normalized_fingerprint)>
```

The implementation lives in `src/bindingMarker.ts`.

The marker is added only to tool-result `structuredContent` as:

```json
{
  "codexpro_binding_marker": "cpb1_..."
}
```

It is intentionally not appended to the human-facing text result. ChatGPT Control can therefore use it as exact binding evidence without injecting probe messages into the conversation.

`cpb1` is a protocol/version prefix. If the derivation changes incompatibly, introduce a new prefix instead of silently changing the meaning of `cpb1`.

## Observability

The integration adds three correlated telemetry kinds:

- request
- tool
- session

Tool events include start/heartbeat/finish and can contain:

- timestamp
- request ID
- MCP session ID
- client-session fingerprint
- requested tool / actual tool
- tool call ID
- bounded/redacted arguments
- duration/status
- bounded result summary

When request logging is enabled, structured lines are also emitted to stderr:

```text
[CodexProRequest] {...}
[CodexProTool] {...}
[CodexProSession] {...}
```

These lines are intentionally machine-readable so a node-local collector can consume ordinary service logs or redirected stderr without scraping user-facing text.

### In-memory telemetry endpoint

CodexPro also keeps a bounded in-memory ring buffer. The default capacity is 4,000 events and can be changed with:

```text
CODEXPRO_TELEMETRY_CAPACITY
```

Observability is enabled unless `CODEXPRO_TELEMETRY=0`.

Recent events are available from:

```http
GET /telemetry/recent?since_seq=<n>&limit=<n>&client_session=<hex fingerprint>
```

Limits are bounded server-side.

The endpoint is behind the same global HTTP token middleware as the rest of the protected HTTP surface. If `CODEXPRO_HTTP_TOKEN` is configured, callers must authenticate in the normal CodexPro way.

## Privacy and logging boundaries

The integration is designed to avoid turning telemetry into a raw transcript:

- tool arguments are passed through existing structured redaction/compaction;
- oversized argument payloads are truncated;
- bash result telemetry stores status/size metadata instead of raw stdout/stderr;
- marker derivation is one-way and exposes neither a ChatGPT thread ID nor the original full fingerprint;
- the marker is correlation metadata, not authentication.

Do not publish telemetry endpoints or log files without the same access controls used for the CodexPro instance itself.

## ChatGPT Control contract

ChatGPT Control should:

1. observe a CodexPro client-session fingerprint;
2. derive the same `cpb1` marker;
3. enumerate only bounded recent/visible ChatGPT thread candidates;
4. read candidates without sending a message;
5. accept an exact marker match as high-confidence binding evidence;
6. persist `fingerprint -> thread_id`;
7. use content/timing forensic fallback only for historical sessions created before markers existed.

A title is presentation metadata. It is not required to discover the thread ID and must not be treated as unique identity.

## Threads WebUI contract

The web service is downstream of the binding system. A collector can publish rows such as:

- thread title
- ChatGPT thread ID
- source node, for example `Home PC`, `Vps-renat`, or `home-server`
- project/workspace
- last activity timestamp
- state

The title may link directly to:

```text
https://chatgpt.com/c/<thread_id>
```

CodexPro itself does not host the Threads UI and does not need access to ChatGPT browser state.

## Multi-node rollout

For every additional CodexPro node:

1. deploy a CodexPro build containing correlated observability and binding markers;
2. ensure request/tool telemetry reaches a collector, either through the authenticated telemetry endpoint or a protected local log/journal;
3. label the collector with a stable source-node name;
4. point binding requests at the central ChatGPT Control binder;
5. verify one real tool call produces a `cpb1` marker;
6. verify that the corresponding ChatGPT thread becomes bound;
7. only then enable recovery/monitoring for that node.

Do not deploy by copying only the collector while leaving CodexPro without marker support; that degrades new sessions to slower forensic matching.

## Tests

The CodexPro side includes:

- `scripts/telemetry-smoke.mjs` — bounded/filterable telemetry behavior;
- `scripts/binding-marker-smoke.mjs` — fingerprint normalization and deterministic marker derivation.

Run at minimum:

```bash
npm run build
node scripts/telemetry-smoke.mjs
node scripts/binding-marker-smoke.mjs
```

The companion ChatGPT Control repository contains the browser-reader, binder, collector, recovery supervisor, and live rollout runbook.
