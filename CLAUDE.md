# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Anthropic-to-DeepSeek bridge: a Bun/TypeScript HTTP server that exposes an Anthropic-compatible `/v1/messages` endpoint and translates requests into calls to the unofficial `chat.deepseek.com` web API. Designed specifically to be used as a drop-in `ANTHROPIC_BASE_URL` for Claude Code itself (see `deepaude.ps1`).

## Commands

```bash
bun install                 # install deps
bun run index.ts            # run server (PORT=4141 by default)
bun --watch run index.ts    # hot reload
```

No test suite, linter, or build step is configured. Bun runs `index.ts` directly and auto-loads `.env` — do not add an explicit `dotenv` call.

Required env: `DEEPSEEK_TOKEN` (raw token from chat.deepseek.com — `userToken` in local storage, or the `Bearer` value from request headers).
Optional: `PORT`, `PROXY_API_KEY` (if set, clients must send matching `x-api-key` header), `CONVERSATION_TTL_MINUTES` (idle eviction window for in-memory sessions, default 60).

To point Claude Code at the bridge: `ANTHROPIC_BASE_URL=http://localhost:4141` + `ANTHROPIC_API_KEY=<PROXY_API_KEY>`. The `deepaude.ps1` helper does this.

Endpoints: `GET /health` returns `{ ok: true, service: "anthropic-deepseek-bridge" }` for smoke tests; `POST /v1/messages` is the Anthropic-compatible endpoint.

## Architecture

Two layers, intentionally kept separate:

**`index.ts`** — the Anthropic-compatible HTTP server (Bun.serve). Owns all translation between Anthropic's Messages API shape and the DeepSeek web protocol:
- `buildDeepseekPrompt(body, isContinuation)` flattens Anthropic's structured messages into a single plaintext prompt with `System:` / `User:` / `Assistant:` markers, because the DeepSeek web API only accepts a flat `prompt` string. **On continuation** (`parentMessageId != null`), `extractLastTurn` slices to messages after the last assistant — the DeepSeek session already holds earlier context via `parent_message_id`, so replaying the whole history confuses the model. The system block is also sent only on the first turn for the same reason. Tool instructions are re-sent every turn because the tool set may change.
- Tool use is emulated: when `tools` are present, the prompt instructs the model to emit a single JSON object `{"tool":..., "arguments":...}`. `parseToolCallFromText` (+ `extractJsonCandidates`) fishes JSON out of the response (including fenced code blocks) and repackages it as an Anthropic `tool_use` content block with `stop_reason: "tool_use"`. The parser is intentionally permissive: it accepts `tool` **or** `name` for the tool name, and `arguments` **or** `input` for the params — keep both when editing the prompt or parser.
- `streamDeepseek` is the single SSE reader for both modes. It yields text chunks as they arrive AND mutates a shared `idState` so that `responseMessageId` is captured mid-stream (needed before we persist `parentMessageId`). It accepts an `AbortSignal` and cancels the upstream reader when the Anthropic client disconnects.
- **Streaming is real.** For `stream: true`, the server pipes DeepSeek tokens through as Anthropic `text_delta` events as they arrive. If `tools` are declared, there's a state machine: `undecided` → `tool` or `text`, based on whether the first non-whitespace chars look like a JSON start (`{` or ```` ```json ````). `PEEK_THRESHOLD = 48` chars of non-JSON prefix flushes to `text` mode. Once in `tool` mode the whole output is buffered to parse the JSON; in `text` mode deltas stream immediately. If JSON parsing at end fails, the buffered text falls back to a single text block.
- Multi-turn continuity uses the `x-claude-code-session-id` header as the key into an in-memory `conversationStore` Map. `parentMessageId` for the next request equals the previous response's `responseMessageId`, extracted via `extractMessageIds` from either root-level `request_message_id`/`response_message_id` fields or the nested `v.response.message_id`/`v.response.parent_id` shape. A `setInterval` sweep (every 5 min, `unref`'d so it doesn't block exit) evicts entries idle beyond `CONVERSATION_TTL_MINUTES`.
- Upstream errors: non-2xx from DeepSeek is mapped to 401 (for 401/403) with a clear "token missing/expired/invalid" hint, or 502 with the upstream body snippet.

**`src/` (CommonJS JavaScript, loaded via `createRequire`)** — the DeepSeek web-API client. `DeepseekClient` → `ChatSession` + `PowService` → `WasmService`. Each `/completion` call requires a fresh Proof-of-Work token: `PowService` fetches a challenge, `WasmService` runs `wasm/sha3_wasm_bg.*.wasm` (algorithm `DeepSeekHashV1`) to solve it, and the base64-encoded answer goes into the `x-ds-pow-response` header built by `HeadersBuilder`. Endpoints and the WASM path live in `src/config/constants.js`.

The `src/` layer streams raw DeepSeek SSE chunks; `index.ts` parses them via `parseStreamLine` + `extractResponseChunks`, which handles three event shapes: full-document snapshots (`event.v.response.fragments`), appends (`p: "response/fragments"`, `o: "APPEND"`), and per-char patches (`p: "response/fragments/-1/content"`). Only fragments with `type === "RESPONSE"` are emitted as text — thinking/search fragments are dropped.

## Gotchas

- **The `src/` directory is CommonJS `.js`**, not TypeScript. `index.ts` bridges it with `createRequire`. New code that belongs to the DeepSeek client should stay in `src/` as `.js` CommonJS unless you're migrating the whole layer.
- **Conversation state is still in-memory only** — evicted on idle TTL and lost on restart. There's no persistence.
- **History delta relies on our map.** If the client sends a request with a `x-claude-code-session-id` we've never seen (or we've evicted), we treat it as a new conversation and replay the full history. If the client manipulates the `messages` array in ways that diverge from what DeepSeek actually saw in its session, the session view drifts — we don't reconcile.
- **Tool-call parsing is heuristic.** In streaming mode, if the first ~48 chars don't look like JSON we lock into text mode and commit; a late-arriving JSON tool call would be emitted as text. Tune `PEEK_THRESHOLD` or `looksLikeJsonStart` if DeepSeek starts preambling.
- **`input_tokens` is always 0** and `output_tokens` is a `Math.ceil(text.length / 4)` estimate — DeepSeek's web API doesn't expose real counts.
- **Vision is not supported.** Image blocks in input are replaced with the literal string `[IMAGE_BLOCK]`.
