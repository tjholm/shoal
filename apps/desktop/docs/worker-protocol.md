# Shoal worker: behavioural specification

This document specifies the existing TypeScript worker (`shoal worker start`, in `apps/cli`) and the parts of the server that constrain it. Its purpose is to let a Rust reimplementation act as a drop-in replacement. A drop-in replacement must:

- speak the same WebSocket protocol;
- read and write the same identity file;
- send the same HTTP requests to inference backends;
- report the same model and stats data.

Source revision: branch `feat/desktop-app` at commit `4639d06`. Every `file:line` reference is relative to the repo root.

Statements marked **(inferred)** come from reasoning about library behaviour, not from code read directly. Statements marked **(observed)** were checked by running the real worker against a fake server and a fake backend (Bun 1.4.2, effect 4.0.3).

---

## 0. Architecture in one paragraph

The worker opens one WebSocket to the server and registers, either as a new worker or by resuming a stored identity. It then:

- every 10 s, probes each configured backend and reports a `models` message and a `stats` message;
- answers each server `ping` with `pong`;
- serves each `infer` job by proxying it to an OpenAI-compatible HTTP backend and streaming the results back as JSON text frames.

The worker does not run inference itself. Each job is routed to the first configured backend that advertised the model id in `/v1/models`.

When the connection drops, the worker reconnects with exponential backoff. The worker exits only for these reasons:

- close code 1008 (credentials rejected);
- an identity file error;
- a CLI or config error.

---

## 1. CLI and environment

Entry point: `apps/cli/bin.ts`. The root command is `shoal`. Its `--version` flag prints `__SHOAL_VERSION__`, a value injected at bundle time, or `dev` (`bin.ts:7-15`). The subcommand path is `shoal worker start [flags]` (`commands/worker.ts:63-93`). The version is **never** sent to the server.

| Flag | Type | Env fallback | Default | Validation | Source |
|---|---|---|---|---|---|
| `--server <url>` | string | **none** | required | none (any string; not parsed as a URL) | `worker.ts:18-22` |
| `--token <key>` | redacted string | `SHOAL_TOKEN` | required | none | `worker.ts:24-29` |
| `--backend <url>` | string, repeatable | `BACKEND_URL` | `http://localhost:11434` | must produce ≥1 non-empty entry after splitting | `worker.ts:31-48`, `67-69` |
| `--concurrency <n>` | int | none | `1` | integer `> 0` | `worker.ts:50-54` |
| `--name <s>` | string, optional | none | absent | none (empty string allowed) | `worker.ts:56-61` |

Effect-CLI also provides these global flags: `--help/-h`, `--version/-v`, `--wizard`, `--completions`, and `--log-level <all|trace|debug|info|warn|warning|error|fatal|none>`.

### `--backend` resolution (exact)

1. If one or more `--backend` flags are given, use only their values. `BACKEND_URL` is ignored.
2. Otherwise, if `BACKEND_URL` is set and non-empty, use `[BACKEND_URL]`. Otherwise use `["http://localhost:11434"]`.
3. Split every value on `,`, trim each part, and drop empty parts (`worker.ts:42-47`).
4. If the result is empty, fail with `NoBackendsConfigured`, which prints `No backend URLs configured. Pass --backend <url> (repeat or comma-separate for multiple) or set BACKEND_URL.` (`worker.ts:14`). For example, `BACKEND_URL=" , "` triggers this **(observed)**.
5. The worker logs `using backend(s): <comma-space joined, as given>` (`worker.ts:70`).
6. Inside the inference client, trailing slashes are stripped from each URL with `/\/+$/` (`inference/index.ts:73`). For example, `http://h:1/` becomes `http://h:1` **(observed)**. Nothing else is normalized: no scheme check, and no dedupe of duplicate URLs.

Effect `Config` treats an empty env var as unset. This was **observed** for `XDG_STATE_HOME=""`, which fell back to the default. **(inferred)** The same applies to `SHOAL_TOKEN` and `BACKEND_URL`.

Validation error messages printed by the real CLI **(observed)**, each after the help text. Exit code 1.

- `Missing required flag: --token`
- `Missing required flag: --server`
- `Invalid value for flag --concurrency: "0". Expected: Schema validation failed: Expected a value greater than 0`

The CLI uses `--concurrency` **only** as `maxConcurrent` in the register message. The worker does **not** enforce it locally (see §7.4).

---

## 2. Identity persistence

Source: `apps/cli/identity.ts`.

### 2.1 Location

```
stateRoot = $XDG_STATE_HOME              if set and non-empty (used verbatim; may be relative → resolved against CWD)
          = join(os.homedir(), ".local", "state")   otherwise
file      = join(stateRoot, "shoal", "identity-" + hex(sha256(utf8(serverUrl)))[0..16] + ".json")
```

- `identity.ts:65-76`. `join` is Node's `path.join` for the platform: `/` on POSIX, `\` on Windows.
- `serverUrl` is the exact `--server` string. It is not normalized and it does **not** include the `token` query parameter. A trailing slash, letter case, or a different host spelling all produce a different file, and therefore a different worker identity.
- Hash: SHA-256 over the UTF-8 bytes of `serverUrl`, encoded as **lowercase** hex, keeping the first 16 hex characters (the first 8 bytes of the digest).
  - Example: `wss://server.shoal.localhost/ws/workers` gives `identity-ee6c2bca4fc6b963.json`. This was **observed**, and it matches `printf '%s' URL | shasum -a 256 | cut -c1-16`.
- macOS: the path is `~/.local/state/shoal/…`, **not** `~/Library/...`.
- Linux: same as XDG.
- Windows **(inferred)**: `os.homedir()` returns `%USERPROFILE%`, for example `C:\Users\Name`. The file is then `C:\Users\Name\.local\state\shoal\identity-xxxxxxxxxxxxxxxx.json`, unless `XDG_STATE_HOME` is set.
  - Rust: do **not** use `dirs::state_dir()` (it is `None` on macOS and Windows) or `dirs::data_local_dir()`.
  - Use the home directory (`$HOME` on POSIX, `%USERPROFILE%`/profile dir on Windows) joined with `.local/state`, exactly as above.
  - Node's `os.homedir()` on POSIX prefers `$HOME`, then falls back to the passwd entry.

### 2.2 Format

The file is UTF-8 JSON written with `JSON.stringify(identity, null, 2)`: two-space indent, **no trailing newline**, key order `workerId` then `secret`. Exact bytes **(observed)**:

```json
{
  "workerId": "w-123",
  "secret": "sek"
}
```

Real values:

- `workerId`: a v4 UUID (`secrets.ts:47-48`).
- `secret`: base64url of 32 random bytes, without padding (`secrets.ts:7,29`) **(inferred: no padding)**.

### 2.3 Read (startup, once per process)

`identity.ts:78-86` and `run.ts:75-84`.

- If the file does not exist, there is no identity. The worker logs `no stored identity, will register as new at <path>`.
- If the file exists, the worker reads it as a string and JSON-decodes it against `{workerId: string, secret: string}`. Extra keys are ignored. Both keys are required and must be strings.
  - On success it logs `loaded identity <workerId> from <path>`.
- Any read, parse, or schema failure raises `IdentityFileError`, and **the process exits** before connecting. The message is `Failed to read worker identity at <path>. Delete the file to re-register as a new worker.` (`identity.ts:31-36`).
- The identity is loaded **once**. It is held in memory and reused on every reconnect. Later changes to the file on disk are not re-read.

### 2.4 Write

The worker writes only on a `registered` message that carries `secret` (`run.ts:220-230`; `identity.ts:88-104`). Steps:

1. Run `mkdir -p dirname(file)` with mode `0o700`. The mode applies only to directories it creates.
2. Write the file with mode `0o600`. This truncates and overwrites any existing file. The mode applies only on creation. The write is **not** atomic: there is no temp file and rename.
3. Update the in-memory identity **before** writing. Later reconnects in the same process use the new credentials.

Any failure raises `IdentityFileError` with reason `write`. That ends the session, and the **process exits** with `Failed to write worker identity at <path>. Delete the file …` (`run.ts:294`). **(inferred)** The socket is closed with code 1000 by the scope finalizer.

On Windows the mode bits are effectively ignored **(inferred)**.

---

## 3. Connection

### 3.1 URL and authentication

`run.ts:63`:

```
wsUrl = serverUrl + (serverUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token)
```

- The token travels **only** in the query string. There is no `Authorization` header, no cookies, and no subprotocol.
- The handshake headers are Bun's defaults: `Host`, `Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, and `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits` **(observed)**. permessage-deflate is optional for compatibility.
- `encodeURIComponent` leaves `A–Z a–z 0–9 - _ . ! ~ * ' ( )` unescaped and percent-encodes everything else as UTF-8, with uppercase hex. For example, the token `a b+c/!*` becomes `token=a%20b%2Bc%2F!*` **(observed)**.
  - Rust's `urlencoding::encode` also escapes `! * ' ( )`. The server decodes either form, so the result is functionally equal, but it is not byte-identical.
  - `+` **must** be encoded, because the server's `URLSearchParams` decodes a literal `+` as a space.
- The `?` check is naive. A `#fragment` in `--server` would swallow the token. If `--server` already contains `token=…`, the server uses the **first** `token` (`gateway.ts:177`).
- The server path is `GET /ws/workers` (`gateway.ts:172-174`). The full URL comes from the user; the CLI help suggests `wss://server.example.com/ws/workers`.
- Server auth: `auth.verifyApiKey(token)` (better-auth API key). It yields `{organizationId, keyId}` (`auth.ts:151-161`). A missing token, an invalid token, or a verification error all count as "no principal" (`gateway.ts:177-183`).

### 3.2 Handshake behaviour

- The server **always** accepts the upgrade with 101, even for a bad key. It then rejects by sending a close frame (`gateway.ts:51-56`). A client therefore never sees a 401 or 403 HTTP status.
- Client open timeout: **10 000 ms**. This is the Effect default (`effect/src/socket/Socket.ts:1110`, `openTimeout ?? 10000`). A timeout is a `SocketOpenError` ("timeout waiting for \"open\""), which is retried with backoff.
- After `open`, the worker logs `connected, registering` and immediately sends **exactly one** register message (`run.ts:98-115`):

| State | Message sent |
|---|---|
| No identity | `{"type":"register_new","maxConcurrent":N}` plus `"name"` if `--name` was given |
| Identity in memory | `{"type":"register_resume","workerId":…,"secret":…,"maxConcurrent":N}` plus `"name"` if `--name` was given |

```json
{"type":"register_new","maxConcurrent":2,"name":"gpu-box"}
{"type":"register_resume","workerId":"9b0c…","secret":"q3…","maxConcurrent":2,"name":"gpu-box"}
```

- `name` is sent verbatim. An empty string is sent as `""`, and the server's `normalizeName` trims it and stores `null`, which clears the name (`registry.ts:528-531`). Omitting `name` keeps whatever name the server has stored.
  - On `register_resume`, a supplied name overwrites the stored name, including one set from the dashboard (`registry.ts:261-278`).
- The server ignores every message other than `register_*` until registration succeeds (`gateway.ts:110-112`). That includes `pong`.

### 3.3 Server replies to registration

`gateway.ts:62-103`, `registry.ts:213-281`.

| Outcome | Server action | Worker reaction |
|---|---|---|
| `register_new` ok | Inserts a row with a new UUID and the hashed secret. Sends `{"type":"registered","workerId":"<uuid>","secret":"<plaintext>"}`. | Saves the identity file, logs `registered (new) as <id>, identity saved`, starts the report loop (§5). |
| `register_resume` ok | Updates `lastSeenAt`, `keyId`, and possibly `name`. Sends `{"type":"registered","workerId":"<id>"}` with **no `secret`**. | Logs `registered (resumed) as <id>`, starts the report loop. |
| Resume: id not found in this org, or wrong secret | `close(1008, "invalid worker credentials")` | Exits (fatal). |
| Resume: that workerId is already live on another socket | `close(1008, "worker already connected")` | Exits (fatal). See §8. |
| DB error during register | `close(1011, "register failed")` | Reconnects with backoff. |

The worker's decision is driven **only** by whether `secret` is present in `registered` (`run.ts:222`), not by which register message it sent.

- Every `registered` message (re)starts a **new** report loop (`run.ts:236-239`). A duplicate `registered` would cause duplicate loops. The server never sends one.
- Secrets are verified server-side as `base64url(salt) + "$" + base64url(sha256(salt ‖ utf8(secret)))`, with a 16-byte salt and a timing-safe comparison (`secrets.ts`). This affects only the server.

### 3.4 Keepalive (server-driven)

`gateway.ts:14-15, 125-133`.

- `PING_INTERVAL = 10 s` and `MAX_MISSED_PINGS = 3`.
- The heartbeat starts `PING_INTERVAL` after the socket is served, whether or not the worker has registered, and then repeats every 10 s.
- On each tick, `missed = missedPings++`:
  - if `missed >= 3`, the server closes with `1001 "ping timeout"`;
  - otherwise it sends `{"type":"ping"}`.
- `pong` resets the counter to 0, but only after registration (§3.2).
- Effective timeline with no pongs: pings at about 10, 20, and 30 s, then a 1001 close at about 40 s.
- The worker replies `{"type":"pong"}` to every `ping`, in order, from the message loop (`run.ts:241-242`).
- The worker sends **no** pings of its own and has **no** client-side liveness timeout. It relies on TCP or WebSocket close detection.

### 3.5 Close codes and the client's response

`run.ts:26-27, 277-303`.

| Code / reason | Origin | Worker behaviour |
|---|---|---|
| `1008` (any reason: `invalid api key`, `invalid worker credentials`, `worker already connected`) | gateway | **Fatal.** Fails with `CredentialsRejected`, prints `credentials rejected by server (1008 <reason>). If you've reset the server's database, delete <identityPath> and restart to re-register as a new worker.`, and exits non-zero. |
| `1001 ping timeout` | gateway heartbeat | Reconnect |
| `1011 register failed` | gateway | Reconnect |
| `1000 worker deleted` | `registry.remove` (`registry.ts:470-476`) | Reconnect. The resume then fails with 1008 because the row is gone, so the worker exits. |
| `1006` / abnormal / transport error / open error / open timeout | network | Reconnect |
| any other code | — | Reconnect |

Only a **close event** with code 1008 is fatal. Read errors (`SocketReadError`) and open errors are retried.

The detail logged is `"<code> <reason>"`, or `"<code>"` when the reason is empty, or the error message for non-close errors (`run.ts:270-275`).

### 3.6 Reconnect and backoff

`run.ts:23-25, 277-303`.

- `INITIAL_RECONNECT_DELAY = 1 s` and `MAX_RECONNECT_DELAY = 30 s`.
- The delay is reset to 1 s **when the socket opens** (`onOpen`, `run.ts:98, 280-282`), not when registration succeeds.
- After **every** session end (other than fatal), the worker:
  1. logs `disconnected (<detail>), reconnecting in <delay>`;
  2. sleeps `delay`;
  3. sets `delay = min(delay*2, 30s)`.
- The sequence for repeated failures to connect is 1, 2, 4, 8, 16, 30, 30, … s.
- A connection that opens and then drops always waits 1 s before the next attempt. There is no jitter.
- Each attempt logs `connecting to <serverUrl>`. The token is not printed.
- When a session ends, its scope closes. That cancels the report loop and **interrupts every in-flight job**. Interrupted jobs send nothing (§7). The in-memory `jobsCompleted` counter and `startedAt` survive across reconnects.

### 3.7 Frames

- All frames are JSON **text** frames in both directions.
- The client decodes incoming binary frames as UTF-8 too, but the server never sends binary.
- A frame that does not decode against `ServerMessage`, including an unknown `type`, is logged as `invalid message from server: <schema error>` and ignored. The connection stays open (`run.ts:256-267`).
- Incoming messages are handled **sequentially**, in arrival order. `infer` handling only forks the job, so it does not block the loop.

---

## 4. Message catalogue

Schemas live in `packages/protocol/index.ts`. Encoding uses `Schema.encodeSync(WorkerMessageJson)`, which is `JSON.stringify` of the schema-encoded value:

- Keys are emitted in **schema declaration order**, regardless of the order in the source object **(observed)**.
- Optional keys are omitted when absent. They are never emitted as `null`.
- There is no whitespace.

Decoding ignores unknown keys on both sides. For example, `options.extra` is dropped silently **(observed)**.

### 4.1 Server → worker (`ServerMessage`, `index.ts:287-313`)

| `type` | Fields | Notes |
|---|---|---|
| `registered` | `workerId: string`, `secret?: string` | `secret` is present only after `register_new`. `null` is a decode error. |
| `infer` | `jobId: string`, `task: "chat"\|"embedding"\|"image"\|"tts"`, `model: string`, `input: unknown` (**key required**, any JSON value including `null`), `options?: InferOptions` | An unknown `task` or a missing `input` key fails decoding, and the message is ignored (no error is sent). |
| `cancel` | `jobId: string` | |
| `ping` | — | |

`InferOptions` (`index.ts:273-284`). All fields are optional:

| Field | Type | Used by |
|---|---|---|
| `maxTokens` | number | chat → `max_tokens` |
| `temperature` | number | chat → `temperature` |
| `tools` | unknown[] | chat → `tools` (only if non-empty) |
| `toolChoice` | unknown | chat → `tool_choice` (if the key is present; `null` counts as present) |
| `image` | `ImageOptions` | image |
| `tts` | `SpeechOptions` | tts |

`ImageOptions`: `size?: string`, `n?: int>0`, `quality?: string`, `style?: string`, `responseFormat?: "url"|"b64_json"`.

- A message whose `n` is not a positive integer, or whose `responseFormat` is not one of those two literals, fails decoding and is **ignored entirely** **(observed for n=0)**.

`SpeechOptions`: `voice?: string`, `responseFormat?: string`, `speed?: number`, `instructions?: string`.

What the server actually sends (`dispatch.ts:275-293`):

- `options` is **always** present. It may be `{}`.
- Only defined fields are included.
- `image` appears only for image jobs, and `tts` only for tts jobs.
- `input` by task:
  - chat: an OpenAI `messages` array (`openai.ts:217-219`; the Anthropic route converts its messages into the OpenAI shape, `anthropic.ts:357-358`);
  - embedding: the request's `input`, a string or a string array;
  - image: the prompt string;
  - tts: the input string.

```json
{"type":"infer","jobId":"5f0e…","task":"chat","model":"llama3.2","input":[{"role":"user","content":"hi"}],"options":{"maxTokens":256,"tools":[…],"toolChoice":"auto"}}
{"type":"cancel","jobId":"5f0e…"}
{"type":"ping"}
```

### 4.2 Worker → server (`WorkerMessage`, `index.ts:77-179`)

Fields are listed in wire order.

| `type` | Fields (in order) | When |
|---|---|---|
| `register_new` | `maxConcurrent: int>0`, `name?: string` | First frame, when there is no identity |
| `register_resume` | `workerId`, `secret`, `maxConcurrent: int>0`, `name?` | First frame, when there is an identity |
| `models` | `models: WorkerModel[]` (legacy `string[]` is accepted by the server but **never sent** by the current worker) | After `registered`, then every cycle (§5) |
| `stats` | `loadedModels: string[]`, `jobsCompleted: number`, `uptimeMs: number` | Immediately after each `models` |
| `model_ready` | `jobId`, `model` | First message for every `infer`, sent before backend resolution |
| `delta` | `jobId`, `content?`, `toolCalls?: ToolCallDelta[]`, `reasoning?` | Chat stream fragments |
| `embedding` | `jobId`, `vector: number[]` | Embedding result |
| `image` | `jobId`, `images: GeneratedImage[]` | Image result |
| `audio` | `jobId`, `b64: string`, `mimeType: string` | TTS result |
| `done` | `jobId`, `finishReason: "stop"\|"length"\|"tool_calls"`, `usage?: {promptTokens:int≥0, completionTokens:int≥0}` | The last message of a successful job |
| `error` | `jobId`, `message: string` | The last message of a failed job |
| `pong` | — | Reply to `ping` |

Sub-shapes:

- `WorkerModel`: `{id: string, purpose?: "chat"|"embedding"|"image"|"tts", capabilities?: ("tools"|"vision"|"thinking")[]}`. Key order is `id, purpose, capabilities`.
- `ToolCallDelta`: `{index: int≥0, id?: string, name?: string, arguments?: string}`.
- `GeneratedImage`: `{b64?: string, url?: string, revisedPrompt?: string}`. Key order is `b64, url, revisedPrompt`.

Exact frames captured from the real worker **(observed)**:

```json
{"type":"models","models":[{"id":"m1","purpose":"chat","capabilities":["tools","thinking"]},{"id":"e1","purpose":"embedding"}]}
{"type":"stats","loadedModels":["m1"],"jobsCompleted":0,"uptimeMs":65}
{"type":"pong"}
{"type":"model_ready","jobId":"j1","model":"m1"}
{"type":"delta","jobId":"j1","reasoning":"hm"}
{"type":"delta","jobId":"j1","content":"Hi","toolCalls":[{"index":0,"id":"c1","name":"f","arguments":"{\"a"}]}
{"type":"done","jobId":"j1","finishReason":"tool_calls","usage":{"promptTokens":3,"completionTokens":4}}
{"type":"embedding","jobId":"j2","vector":[0.5,1]}
{"type":"done","jobId":"j2","finishReason":"stop"}
{"type":"audio","jobId":"j4","b64":"AQID","mimeType":"audio/wav"}
{"type":"done","jobId":"j4","finishReason":"stop"}
{"type":"error","jobId":"j3","message":"No configured backend serves model \"nope\". Known models: m1, e1"}
```

Number formatting follows JavaScript `JSON.stringify`. For example, `1` is written `1`, not `1.0`, and `1e-7` stays `1e-7` **(observed)**. A Rust implementation that re-serializes backend floats may format them differently, for example `1.0` or `0.0000001`. That is semantically equal JSON but not byte-identical. Consider passing `vector` values through as raw JSON numbers.

### 4.3 How the server consumes worker messages

`gateway.ts:105-123`, `dispatch.ts:359-388`, `registry.ts:291-329`.

- `pong` resets the missed-ping counter.
- `stats`: `recordStats` overwrites `loadedModels` and `jobsCompleted` on the live worker. `uptimeMs` is **ignored** by the server.
  - Changes trigger a live event. The comparison is order-insensitive set equality, plus `jobsCompleted` equality.
  - `loadedModels` drives warm/cold preference in `reserve` (`registry.ts:344-368`).
- `models`: `normalizeWorkerModels` collapses legacy `string[]` into `{id}[]` (`index.ts:235-250`).
  - `availableModels` is always replaced.
  - "Changed" means the length differs or the `id` at any position differs. Changes to purpose or capabilities alone are not detected, so they emit no event and are not persisted.
  - On a change with a non-empty list, the list is persisted to the DB. An empty list is never persisted.
- `model_ready` is accepted, but the dispatcher ignores it. There is no `case` for it (`dispatch.ts:364-387`).
- `delta`, `embedding`, `image`, `audio` are queued to the job. The job is looked up by `jobId` and must belong to this worker; otherwise the message is ignored.
- `done` finishes the job, records usage (chat only, and only if `usage` is present), ends the stream, and calls `release(completed)`.
- `error` fails the job with `JobFailed{message}` and calls `release(abandoned)`. The message reaches API clients.
- Messages for unknown or finished jobs are ignored silently. Any `delta` after `done` is dropped.

---

## 5. Model and stats reporting cycle

`run.ts:120-132, 220-240`.

- After **each** `registered`, the worker forks a loop:
  1. run `refreshAndReport`;
  2. wait `STATS_INTERVAL = 10 s` (`Schedule.spaced`, so the gap is measured from the **end** of the previous run);
  3. repeat.
- The first report is immediate, with no initial delay.
- `refreshAndReport`:
  1. `client.refresh` probes every backend in parallel (§6) and returns `{models, loaded}`;
  2. sends `{"type":"models","models":models}`;
  3. sends `{"type":"stats","loadedModels":loaded,"jobsCompleted":<counter>,"uptimeMs":now-startedAt}`.
- `models` is always sent before `stats`, and both come from the **same** probe. `models` is sent on every cycle, even when it is unchanged. It can be `[]` if every backend failed.
- `jobsCompleted` is a per-**process** counter. It is not per connection and is not reset on reconnect.
  - It is incremented once per job that reaches `done` (§7.2).
  - Errors, cancellations, and interruptions do not increment it.
- `uptimeMs` is milliseconds since **process** start (`run.ts:69`, `Clock.currentTimeMillis`). It is not connection uptime.
- If a send fails because the socket closed, the loop stops. The session is ending anyway.
- The extra refresh triggered by a routing cache miss (§6.5) does **not** send `models` or `stats` **(observed)**.

---

## 6. Backends and model discovery

Sources: `inference/index.ts`, `inference/models/*.ts`, and `inference/backend.ts`.

### 6.1 HTTP client behaviour (all backend calls)

- The client is Bun's `fetch`, via Effect's `FetchHttpClient`. It applies no timeout to any backend request, follows redirects (fetch default), and decompresses gzip/br/zstd.
- Request headers **(observed)**: `accept: */*`, `accept-encoding: gzip, deflate, br, zstd`, `user-agent: Bun/<ver>`, plus tracing headers `traceparent` and `b3` that Effect adds automatically.
  - POST requests add `content-type: application/json`.
  - There is no `Authorization` header. Backends are assumed to be unauthenticated.
  - The tracing headers are incidental. Omitting them is compatible.
- JSON bodies use `JSON.stringify`. Keys whose value is `undefined` are **omitted**.
- `execute` (`backend.ts:11-29`):
  - A transport failure becomes `BackendError{message: <HttpClientError message>}`. For a transport error the message has the form `Transport error (<METHOD> <url>)`, or `Transport: <description> (<METHOD> <url>)` when a description exists **(inferred from `HttpClientError.ts:86-121`)**.
  - A status outside 200–299 reads the body as text (`""` if that fails) and becomes `BackendError{message: "Backend returned <status>: <body>"}`.
- `bodyJson` (`backend.ts:32-46`): a schema decode failure becomes `"Unexpected response body: <schema issue text>"`. The issue text is Effect-specific and cannot be reproduced byte for byte.

### 6.2 Dialect detection (`ModelDiscovery.available`, `models/index.ts:139-187`)

For each backend URL `B`:

1. `GET B/v1/models`. Decode the response as `{data: RawModelEntry[]}`.
   - `RawModelEntry` (`models/types.ts:7-21`): `id: string` (required), plus optional typed fields:
     - `owned_by: string`;
     - `recipe: string`, `labels: string[]`, `max_context_window: number`;
     - `type: string`, `arch: string`, `state: string`;
     - `permission: unknown[]`, `max_model_len: number`.
   - **The decode is strict on these fields.** If any entry has a wrongly typed known field, for example `"owned_by": null` or `"labels": "x"`, the whole response fails to decode. The backend then contributes **no models** for this cycle, and the worker logs an error **(inferred)**.
   - Unknown fields are ignored.
2. Test the dialects in order. The first match wins. Each test is "**any** entry satisfies the condition":

| # | Dialect | Detection condition | Extra HTTP |
|---|---|---|---|
| 1 | `lemonade` | the entry has a `labels` **or** `max_context_window` key | none |
| 2 | `lmstudio` | at least 2 of `type`, `arch`, `state` are present on the same entry | none |
| 3 | `vllm` | `owned_by === "vllm"`, **or** (`permission` present **and** `max_model_len` present) | none |
| 4 | `llamaswap` | `owned_by === "llama-swap"` | none |
| 5 | `llamacpp` | `GET B/props` returns 2xx JSON that decodes as an object containing at least one of the keys `chat_template`, `default_generation_settings`, `total_slots` (any value, including `null`) | `GET /props`, **memoized per backend URL for the process lifetime**, both true and false; any failure counts as false |
| 6 | `ollama` | fallback (also any generic OpenAI-compatible server) | `POST /api/show` per model (below) |

Two details about this table:

- With an empty `data` array, steps 1–4 do not match. The `/props` probe still runs, and the result is `llamacpp` or `ollama` with no models.
- `/props` is probed only when steps 1–4 fail. If `GET /v1/models` fails, nothing is memoized.

### 6.3 Normalization per dialect

`WorkerModel` output is built in `/v1/models` order.

- **lemonade** (`lemonade.ts`):
  - `purpose` comes from `recipe` via the map `{"sd-cpp":"image", kokoro:"tts", flm:"chat", llamacpp:"chat", ryzenai:"chat"}`.
  - An unknown recipe leaves `purpose` absent and logs a warning **once per recipe string per process**.
  - A missing recipe leaves `purpose` absent.
  - `capabilities` come from `labels`, in the **fixed order** `tools` (`"tool-calling"`), `vision` (`"vision"`), `thinking` (`"reasoning"`). The key is included only if the list is non-empty.
- **lmstudio** (`lmstudio.ts:46-60`):
  - `type: "llm"` → `{purpose:"chat"}`;
  - `type: "vlm"` → `{purpose:"chat",capabilities:["vision"]}`;
  - `type: "embeddings"` → `{purpose:"embedding"}`;
  - anything else → `{id}` only.
- **vllm**: `{id}` only.
- **llamaswap**: `{id}` only.
- **llamacpp**: `{id, purpose:"chat"}` for every entry.
- **ollama** (`ollama.ts`, `models/index.ts:117-137`):
  - If the id list is empty, or this backend is memoized as "show unavailable", the result is `{id}` for each model.
  - Otherwise the worker sends `POST B/api/show` with body `{"name":"<id>"}` for **every** model, with concurrency **4** (`OLLAMA_PROBE_CONCURRENCY`), on **every** refresh.
  - The response is decoded as `{capabilities?: string[]}`:
    - `purpose` = `"chat"` if the capabilities include `"completion"`, else `"embedding"` if they include `"embedding"`, else absent;
    - `capabilities`, in the fixed order `tools`, `vision`, `thinking`, filtered by membership; included only if non-empty.
  - A failed probe (any error or decode failure) yields `{id}`.
  - If **no** probe succeeded, the backend is memoized permanently as show-unavailable, and the worker logs once: `backend <B> did not respond to /api/show; model capabilities will be reported as unknown and the server will route to it permissively.`

### 6.4 Residency (`loaded`)

`models/index.ts:203-221`. This is fetched right after `available`, using the dialect just detected.

| Dialect | Request | Loaded ids |
|---|---|---|
| ollama | `GET B/api/ps` → `{models?: [{model?: string, name?: string}]}` | for each entry, `model ?? name` (skip if both are absent) |
| lmstudio | `GET B/v1/models` (a fresh second call) | `data[].id` where `state === "loaded"` |
| llamaswap | `GET B/running` → `{running: [{model: string, state: string}]}` (both required) | `model` where `state === "ready"` |
| lemonade | `GET B/api/v1/health` → `{all_models_loaded?: [{model_name?: string}]}` | each `model_name` that is present |
| vllm, llamacpp | none | every advertised id |

If the residency fetch fails, the worker logs `failed to fetch loaded models from <B> (<dialect>): <msg>` and uses `loaded = []`. The models are still reported. A generic OpenAI server detected as `ollama` therefore logs a `/api/ps` failure every cycle.

If `available` fails, the worker logs `failed to fetch models from <B>: <msg>`, and the backend contributes `models=[]` and `loaded=[]` (`inference/index.ts:82-110`).

### 6.5 Merging and routing

`inference/index.ts:112-159`.

- `refresh` probes all backends with **unbounded** parallelism. Results are kept in **configured order**.
  - `models` = concatenation of all backends' models, deduped by `id`, keeping the **first** occurrence. The first-configured backend's purpose and capabilities win.
  - `loaded` = concatenation, deduped, keeping the first occurrence.
  - The routing cache is replaced with `Map<backendUrl, Set<id>>`. A backend that failed gets an empty set, so its models become unroutable until it recovers.
- `resolveBackend(model)`:
  1. Pick the first backend URL, in configured order, whose cached set has `model`.
  2. On a miss, run one full `refresh`. This includes the `/api/show` probes, but no `models` or `stats` message is sent. Then retry.
  3. If it still misses, fail with `NoBackendForModel`. Its message is `No configured backend serves model "<model>". Known models: <ids joined ", ">`, or `… No backends reported any models.` when the set is empty (`errors.ts:21-28`). `knownModels` is the union over backends in configured order.
- **Routing ignores `task` and `purpose`.** A job goes to the backend that has the id, whatever the model's purpose. The server enforces purpose (`registry.ts:541-549`).

### 6.6 Task requests

The URL is always `<backendUrl><path>`, where `backendUrl` has its trailing slashes stripped.

#### Chat: `POST /v1/chat/completions`

Source: `chat.ts:111-191`.

Body, in this key order. `undefined` values are omitted:

```json
{"model":"m1","messages":<input verbatim>,"stream":true,"stream_options":{"include_usage":true},"max_tokens":5,"temperature":0.7,"tools":[…],"tool_choice":"auto"}
```

- `max_tokens` = `options.maxTokens` and `temperature` = `options.temperature`. Each is included only if present.
- `tools` is included only if it is a non-empty array. **(observed)** `tools: []` is omitted.
- `tool_choice` is included if `toolChoice` is not undefined.
- `messages` is `input` passed through untouched, even if it is not an array.

The response body is parsed as SSE, whatever its `Content-Type`:

- Text is decoded as streaming UTF-8, with replacement characters for invalid bytes. A leading BOM is stripped.
- Lines end in `\n`, `\r`, or `\r\n`. A line starting with `:` is a comment.
- `data:` values are joined with `\n`. The single space after the colon is stripped.
- An event is dispatched on a blank line, but only if its data is non-empty. A trailing event with no closing blank line at EOF is **dropped**.
- The `event:` name is ignored; every event is processed. `id:` is ignored.
- A `retry: <digits>` line makes the stream fail with `"Chat stream ended with an SSE retry directive"`, after events already buffered from the same chunk are delivered.
- An event over 10 MiB (`10*1024*1024`) fails with `"Chat stream failed: Pending SSE event exceeded the maximum size of 10485760"`.
- Any other read error becomes `"Chat stream failed: <msg>"`.

Per event:

1. If `data === "[DONE]"`, skip it. It does **not** end processing: the stream continues until the HTTP body ends.
2. JSON-decode `data` against the chunk schema (`chat.ts:29-67`). Every field is optional or nullable:
   - `usage{prompt_tokens: number, completion_tokens: number}`;
   - `choices[{finish_reason, delta{content, reasoning, reasoning_content, tool_calls[{index: number (required), id, function{name, arguments}}]}}]`.

   If decoding fails, the worker logs a warning `skipping malformed chat chunk from <B>: <data>` and drops the **whole** chunk. This also happens when `usage` lacks `completion_tokens` or a tool call lacks `index`.
3. If `usage` is truthy, then `usage = {promptTokens, completionTokens}`. The last one wins.
4. If `choices[0].finish_reason` is one of `stop|length|tool_calls`, store it as `finishReason`. The last one wins. Other values (`content_filter`, `eos`, …) are ignored. The default is `"stop"`.
5. Build a delta from **`choices[0]` only** (`toDelta`, `chat.ts:77-104`):
   - `content` = `delta.content` if it is a non-empty string;
   - `reasoning` = `delta.reasoning || delta.reasoning_content`. A non-empty `reasoning` takes precedence; empty strings count as absent;
   - `toolCalls` = mapped from `tool_calls` if non-empty: `{index, id?, name?, arguments?}`. Each optional field is included when not null/undefined, **including empty strings**;
   - if all three are absent, send nothing (for example, role-only chunks);
   - otherwise send `{"type":"delta","jobId",content?,toolCalls?,reasoning?}`.
6. When the body ends successfully, send `done` with `finishReason`, plus `usage` if any was seen.
   - A backend that ignores `stream:true` and returns plain JSON yields **no deltas** and `done` with `stop`. **(inferred)** There is no `data:` line to parse.

#### Embedding: `POST /v1/embeddings`

Source: `embedding.ts`.

- The body is `{"model","input"}`. `input` is passed through: a string or an array.
- The response is decoded as `{data: [{embedding: number[]}]}`.
- The worker sends `{"type":"embedding","jobId","vector": data[0].embedding}`. **Only the first vector is sent**, even for array input **(observed)**. Then it sends `done` (§7.2).

#### Image: `POST /v1/images/generations`

Source: `image.ts`.

- The body is `{"model","prompt":input,"size","n","quality","style","response_format"}`, in that order, from `options.image`. Absent fields are omitted.
- The response is decoded as `{data: [{b64_json?: string, url?: string, revised_prompt?: string}]}`.
- The worker sends `{"type":"image","jobId","images":[{b64?,url?,revisedPrompt?}]}`, then `done`.

#### TTS: `POST /v1/audio/speech`

Source: `speech.ts`.

- The body is `{"model","input","voice","response_format","speed","instructions"}`, in that order, from `options.tts`. Absent fields are omitted.
- The response is read as raw bytes and encoded as standard base64, with padding.
- `mimeType` is resolved in this order:
  1. the response `content-type` header **verbatim**, including any parameters;
  2. otherwise the format map `{mp3:"audio/mpeg", opus:"audio/opus", aac:"audio/aac", flac:"audio/flac", wav:"audio/wav", pcm:"audio/pcm"}[options.tts.responseFormat]`;
  3. otherwise `"application/octet-stream"`.
- The worker sends `{"type":"audio","jobId","b64","mimeType"}`, then `done`.

---

## 7. Job lifecycle, cancellation, errors

### 7.1 Server side (context)

The server's `reserve` (`registry.ts:344-368`) chooses a worker in the organization that meets all of these conditions:

- it advertises the model;
- its `purpose` for the model is absent or equal to the task;
- `inFlight < maxConcurrent`.

Among those workers it prefers ones with the model in `loadedModels`, and then the lowest `inFlight`. It increments `inFlight` and sends `infer`.

If no worker has capacity, the API call fails immediately with `WorkersBusy`. The server does not queue jobs. If no connected worker serves the model at all, the result is `ModelOffline` or `ModelNotServed` (`dispatch.ts:236-258`).

### 7.2 Worker side, per `infer`

Source: `run.ts:141-209, 243-246`.

1. Run the job in a fiber keyed by `jobId`. An existing fiber with the same key is interrupted and replaced, though this never happens with UUIDs.
2. Send `model_ready{jobId, model}` immediately, **before** checking that any backend serves the model.
3. Resolve the backend (§6.5) and run the task.
4. On success:
   - **chat**: send each `delta`. At the end of the stream, `jobsCompleted++`, then send `done{finishReason, usage?}`.
   - **embedding / image / tts**: send the result message, then `jobsCompleted++`, then send `done{finishReason:"stop"}`, with no usage.
5. On a failure in the error channel (`BackendError`, `NoBackendForModel`, or a socket send error):
   - log `inference error for job <id>`;
   - send `{"type":"error","jobId","message": err.message}`;
   - send no `done`.

   Deltas already sent are not retracted. A chat stream that fails midway sends deltas, then `error`.
6. On interruption (cancel, or session end): log `job <id> aborted` and send **nothing**.
7. When the fiber ends, it removes itself from the map.

### 7.3 `cancel`

Source: `run.ts:247-252`.

- If `jobId` is in flight, the worker logs `cancel received for job <id>` and interrupts the fiber. For chat, this aborts the in-flight fetch (**inferred**: Effect's fetch client aborts on interruption). Nothing is sent back.
- An unknown or finished `jobId` is ignored silently.
- The server has already removed the job and released the slot before it sends `cancel` (`dispatch.ts:222-234`). It sends `cancel` when the API consumer stops reading the event stream, for example when a client disconnects.

### 7.4 Concurrency

The worker runs **every** `infer` it receives concurrently. It has no local limit, no queue, and no busy rejection. `maxConcurrent` is only advertised; capacity is enforced solely by the server's `reserve`. For backend calls:

- refresh is unbounded across backends;
- `/api/show` runs at concurrency 4 per backend.

### 7.5 Disconnect mid-job

When the socket ends:

- **Worker:** it interrupts all jobs and sends nothing for them.
- **Server:** `abandonWorker` fails each job on that worker with `"Worker disconnected"` (`dispatch.ts:390-400`). It then removes the worker from the live map.

Results are not replayed after a reconnect.

### 7.6 Defects (bugs to be aware of)

Encoding happens synchronously inside `send`. If a value fails the outgoing schema, `encodeSync` **throws**. Effect treats the throw as a defect, which `Effect.catch` does not catch. The job fiber dies silently, and the worker sends **neither `error` nor `done`** **(inferred)**. The server job then waits until the worker disconnects, because there is no server-side job timeout. Cases that trigger this:

- The embedding response has `data: []`, so `vector` is `undefined`.
- `usage.prompt_tokens` or `usage.completion_tokens` is not a non-negative integer. For example, a backend sends `-1` or `3.0`. (`3.0` is an integer in JavaScript and is accepted.)
- A tool-call `index` is negative or fractional.

A Rust implementation should probably send `{"type":"error",…}` in these cases. That is an improvement, not a byte-compatible behaviour.

### 7.7 Logging that matters

The logs do not affect the protocol. Users may rely on these lines, so they are listed here:

- `connecting to <url>`
- `connected, registering`
- `registered (new) as <id>, identity saved`
- `registered (resumed) as <id>`
- `disconnected (<code reason>), reconnecting in <dur>`
- `invalid message from server: …`
- `inference error for job <id>`
- `cancel received for job <id>`
- `job <id> aborted`
- the backend probe warnings and errors in §6

The level is set with `--log-level`.

---

## 8. Subtleties a reimplementation is likely to get wrong

1. **"worker already connected" is fatal.** The server rejects a resume while it still holds the old live entry for that workerId. A quick reconnect after a half-open drop gets `1008 worker already connected`. Because the worker treats **every** 1008 as fatal, it exits. The old entry is removed only when the server notices the old socket closing, or when the heartbeat evicts it (≤40 s). This is the current behaviour; replicate it consciously.
2. **The backoff resets on socket open, not on registration.** A server that accepts and then immediately closes with a non-1008 code causes a reconnect every ~1 s, forever.
3. **The identity is loaded once and then kept in memory.** After a `register_new` success, the new identity is used for later reconnects in the same process.
4. **`model_ready` is sent even for models that no backend serves.** It comes before the `error`.
5. **The `jobsCompleted` increment comes before `done`** (chat), or between the result message and `done` (other tasks). It is per process, and stats send the cumulative value. Server-side, the value is overwritten by stats, and `bind` resets it to 0 on connect.
6. **`models` is sent every cycle, even when unchanged, and always before `stats`.** It is sent in object form only. The legacy `string[]` form triggers a server deprecation warning.
7. **An empty `models` list (`[]`)** is legal and is sent when every backend fails. The server stops routing to the worker but keeps the DB copy.
8. **Only `choices[0]`** of a chat chunk is read. `reasoning` beats `reasoning_content`. `[DONE]` does not terminate the stream; EOF does.
9. **A malformed chunk drops all of its data**, including usage or tool calls in it, because the schema is strict about types.
10. **`/v1/models` decoding is strict about known field types.** One entry with `owned_by: null` makes the whole backend report nothing.
11. **Dialect detection uses "any entry" semantics and a fixed order.** For example, a single entry with `labels` makes the whole backend Lemonade. LM Studio needs two of `type`/`arch`/`state` on the **same** entry.
12. **`/props` and the "Ollama show-unavailable" flag are memoized for the process lifetime.** Ollama `/api/show` probes otherwise repeat on **every** 10 s cycle, for every model.
13. **Routing is by id only**, to the first configured backend that has the id in its **last** refresh. A routing miss triggers one synchronous full refresh, and that refresh sends no `models` message.
14. **`tools: []` is omitted. `tool_choice: null` is sent** if the server includes `toolChoice: null`.
15. **Optional request fields are omitted, never sent as `null`.** This applies to `max_tokens`, `temperature`, `size`, `voice`, and the rest.
16. **The TTS `mimeType` uses the raw Content-Type header verbatim**, for example `audio/wav; codecs=1`.
17. **The embedding result contains only the first vector.**
18. **The token goes in the query string, with `encodeURIComponent` semantics.** `+` must become `%2B`.
19. **The server never answers a bad key with an HTTP error.** It upgrades, then sends `close 1008 "invalid api key"`.
20. **Unregistered pongs are ignored**, so a connection that never registers is evicted after about 40 s with code 1001.
21. **Invalid `infer` frames are ignored without an `error` reply.** Examples: a bad `task`, a missing `input` key, or `image.n` ≤ 0. The server's job then hangs until disconnect. Matching this keeps compatibility; replying with `error` is safer, because the server handles `error` for any job it owns.
22. **A key-order-sensitive comparison requires the schema-declared order shown in §4.2.** For example, `delta` emits `content`, `toolCalls`, `reasoning`, and `GeneratedImage` emits `b64`, `url`, `revisedPrompt`.
23. **The identity file has no trailing newline**, uses a two-space indent, and is created with mode 0600 inside a 0700 directory.
24. **The identity filename hashes the raw `--server` string**, not a normalized URL, and not the URL with the token.
25. **On SIGINT** **(inferred)**, the scope finalizers interrupt the jobs (sending nothing) and close the socket with code 1000. The server abandons the jobs.

---

## 9. Constants

| Name | Value | Location |
|---|---|---|
| `STATS_INTERVAL` | 10 s (spaced, measured after completion) | `apps/cli/worker/run.ts:23` |
| `INITIAL_RECONNECT_DELAY` | 1 s | `run.ts:24` |
| `MAX_RECONNECT_DELAY` | 30 s | `run.ts:25` |
| `CLOSE_POLICY_VIOLATION` (fatal) | 1008 | `run.ts:27`, `gateway.ts:17` |
| WS open timeout | 10 000 ms | effect `socket/Socket.ts:1110` |
| `PING_INTERVAL` | 10 s (first ping after 10 s) | `apps/api/src/workers/gateway.ts:14` |
| `MAX_MISSED_PINGS` | 3 → close 1001 `ping timeout` | `gateway.ts:15, 127-129` |
| `CLOSE_GOING_AWAY` / `CLOSE_INTERNAL_ERROR` | 1001 / 1011 | `gateway.ts:16, 18` |
| `OLLAMA_PROBE_CONCURRENCY` | 4 | `inference/models/ollama.ts:21` |
| SSE max event size | 10 485 760 bytes | effect `encoding/Sse.ts` (`defaultMaxEventSize`) |
| Default backend | `http://localhost:11434` | `commands/worker.ts:38` |
| Default concurrency | 1 | `commands/worker.ts:53` |
| Worker secret / salt size (server) | 32 / 16 bytes | `apps/api/src/workers/secrets.ts:7-8` |

---

## 10. Compatibility checklist

Each statement is testable against a fake server and a fake backend.

**CLI and identity**

- [ ] With no `--backend` and no `BACKEND_URL`, the worker uses `http://localhost:11434`. `--backend a,b --backend c` yields `[a, b, c]`. An empty result exits with the NoBackendsConfigured message.
- [ ] `--concurrency 0` or a non-integer is rejected. The value is sent as `maxConcurrent`.
- [ ] `--token` falls back to `SHOAL_TOKEN`. `--server` has no env fallback.
- [ ] The identity path is `${XDG_STATE_HOME:-$HOME/.local/state}/shoal/identity-<first 16 lowercase hex of sha256(--server string)>.json`. An empty `XDG_STATE_HOME` counts as unset.
- [ ] The identity file content is exactly `{\n  "workerId": "<id>",\n  "secret": "<s>"\n}` with no trailing newline. The directory is created 0700 and the file 0600.
- [ ] A corrupt or invalid identity file makes the worker exit before connecting.
- [ ] The identity is written only when `registered` carries `secret`. A write failure exits the process.

**Connection**

- [ ] The WS URL is `--server` + (`&` if it contains `?`, else `?`) + `token=` + encodeURIComponent(token).
- [ ] The first frame after open is `register_new` or `register_resume`, with keys in schema order. `name` appears only when `--name` is given, including `""`.
- [ ] The worker sends nothing else until it receives `registered`.
- [ ] Every `{"type":"ping"}` gets `{"type":"pong"}`. The worker never sends unsolicited pings.
- [ ] A close with code 1008 (any reason) makes the worker exit non-zero without reconnecting.
- [ ] Any other close or error leads to reconnect after 1, 2, 4, 8, 16, 30, 30 … s. The delay resets to 1 s on each successful socket open.
- [ ] Reconnects after a successful `register_new` use `register_resume` with the saved credentials.

**Reporting**

- [ ] Immediately after `registered`, the worker sends `models`, then `stats`, and repeats every 10 s, measured from the end of the previous cycle.
- [ ] `stats.uptimeMs` is measured from process start. `stats.jobsCompleted` is cumulative per process and counts only jobs that ended in `done`.
- [ ] `models` dedupes by id, first configured backend wins. `loaded` is deduped and kept in configured order.

**Jobs**

- [ ] The first message for every `infer` is `model_ready`, even for unknown models.
- [ ] An unknown model produces `error` with `No configured backend serves model "<m>". Known models: a, b` after one extra refresh.
- [ ] A chat request body is exactly `{model, messages, stream:true, stream_options:{include_usage:true}, [max_tokens], [temperature], [tools if non-empty], [tool_choice]}`.
- [ ] A chat role-only chunk produces no delta. `reasoning_content` maps to `reasoning`. Empty strings are dropped. Only `choices[0]` is used.
- [ ] A malformed SSE data chunk is skipped and the stream continues. `[DONE]` is skipped and EOF ends the stream.
- [ ] Chat `done.finishReason` is the last of `stop|length|tool_calls` seen, defaulting to `stop`. `usage` is mapped from the last usage chunk and omitted if none was seen.
- [ ] Embedding sends only `data[0].embedding`, then `done{stop}` with no usage.
- [ ] Image maps `b64_json→b64`, `url→url`, `revised_prompt→revisedPrompt`, then `done{stop}`.
- [ ] TTS base64-encodes the body. Its `mimeType` is Content-Type, else the format map, else `application/octet-stream`. Then `done{stop}`.
- [ ] A non-2xx backend response produces `error` with `Backend returned <status>: <body>`, and no `done`.
- [ ] `cancel` for a running job aborts the backend request and sends nothing. `cancel` for an unknown job is a no-op.
- [ ] Jobs are never refused locally. N concurrent `infer` messages run concurrently whatever `maxConcurrent` is.
- [ ] On disconnect, in-flight jobs are dropped silently and are not resumed after reconnect.

**Discovery**

- [ ] Dialect detection order is lemonade → lmstudio → vllm → llamaswap → llamacpp (`/props`, memoized) → ollama.
- [ ] Residency endpoints are: ollama `/api/ps` (`model ?? name`); lmstudio `/v1/models` `state=="loaded"`; llamaswap `/running` `state=="ready"`; lemonade `/api/v1/health` `all_models_loaded[].model_name`; vllm and llamacpp report all advertised models.
- [ ] Ollama `POST /api/show {"name":id}` runs per model on every refresh at concurrency 4. If none succeed, the backend is permanently marked capability-unknown.
- [ ] Capabilities are always ordered `tools, vision, thinking`, and the key is omitted when the list is empty. Purpose follows the mapping tables in §6.3.
- [ ] A backend whose `/v1/models` fails, or fails to decode, contributes no models and no loaded ids that cycle, and its models become unroutable.
