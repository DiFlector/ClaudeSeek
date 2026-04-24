import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DeepseekClient = require("./src/client/DeepseekClient");

type Role = "user" | "assistant";
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: unknown }
  | { type: "tool_use"; id?: string; name: string; input?: unknown }
  | { type: "tool_result"; tool_use_id?: string; is_error?: boolean; content?: unknown };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

interface AnthropicMessage {
  role: Role;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: unknown;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
}

interface DeepseekSession {
  getId(): string;
  getParentMessageId(): number | null;
  setParentMessageId(parentMessageId: number | null): number | null;
}

interface DeepseekClientInstance {
  initialize(): Promise<void>;
  createSession(): Promise<DeepseekSession>;
  sendMessage(
    message: string,
    session?: DeepseekSession | null,
    options?: { thinking_enabled?: boolean; search_enabled?: boolean },
  ): Promise<Response>;
}

interface DeepseekPatchEvent {
  p?: string;
  o?: string;
  v?: unknown;
}

interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ConversationState {
  session: DeepseekSession;
  parentMessageId: number | null;
  updatedAt: number;
}

const PORT = Number(process.env.PORT ?? "4141");
const TOKEN = process.env.DEEPSEEK_TOKEN;
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const CONVERSATION_TTL_MS = Math.max(
  60_000,
  Number(process.env.CONVERSATION_TTL_MINUTES ?? "60") * 60_000,
);
const CONVERSATION_SWEEP_MS = 5 * 60_000;

if (!TOKEN) {
  throw new Error("Missing DEEPSEEK_TOKEN in environment (see .env)");
}

let clientPromise: Promise<DeepseekClientInstance> | null = null;
const conversationStore = new Map<string, ConversationState>();

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of conversationStore) {
    if (now - state.updatedAt > CONVERSATION_TTL_MS) {
      conversationStore.delete(key);
    }
  }
}, CONVERSATION_SWEEP_MS).unref?.();

function getClient(): Promise<DeepseekClientInstance> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new DeepseekClient(TOKEN) as DeepseekClientInstance;
      await client.initialize();
      return client;
    })();
  }

  return clientPromise;
}

function writeSseEvent(
  controller: ReadableStreamDefaultController<string>,
  event: string,
  payload: Record<string, unknown>,
): void {
  controller.enqueue(`event: ${event}\n`);
  controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);
}

function toCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function unknownContentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        if (item.trim().length > 0) {
          chunks.push(item.trim());
        }
        continue;
      }

      if (!item || typeof item !== "object") {
        continue;
      }

      const record = item as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string" && record.text.trim().length > 0) {
        chunks.push(record.text.trim());
      } else {
        chunks.push(toCompactJson(item));
      }
    }
    return chunks.join("\n").trim();
  }

  if (value && typeof value === "object") {
    return toCompactJson(value);
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function extractMessageText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        texts.push(block.text.trim());
      }
      continue;
    }

    if (block.type === "tool_use") {
      texts.push(
        [
          "[TOOL_USE]",
          `name=${block.name}`,
          `id=${block.id ?? "unknown"}`,
          `input=${toCompactJson(block.input ?? {})}`,
        ].join(" "),
      );
      continue;
    }

    if (block.type === "tool_result") {
      const rendered = unknownContentToText(block.content);
      texts.push(
        [
          "[TOOL_RESULT]",
          `tool_use_id=${block.tool_use_id ?? "unknown"}`,
          `is_error=${block.is_error === true ? "true" : "false"}`,
        ].join(" "),
      );
      if (rendered.length > 0) {
        texts.push(rendered);
      }
      continue;
    }

    if (block.type === "image") {
      texts.push("[IMAGE_BLOCK]");
    }
  }

  return texts.join("\n").trim();
}

function extractSystemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") {
    return system.trim();
  }

  if (Array.isArray(system)) {
    const texts: string[] = [];
    for (const block of system) {
      if (!block || typeof block !== "object") continue;

      const maybeText = (block as { text?: unknown }).text;
      if (typeof maybeText === "string" && maybeText.trim().length > 0) {
        texts.push(maybeText.trim());
      }
    }

    return texts.join("\n").trim();
  }

  if (system && typeof system === "object") {
    const maybeText = (system as { text?: unknown }).text;
    if (typeof maybeText === "string") {
      return maybeText.trim();
    }
  }

  return "";
}

function extractLastTurn(messages: AnthropicMessage[]): AnthropicMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      return messages.slice(i + 1);
    }
  }
  // No assistant in history but isContinuation=true: DeepSeek session already
  // holds prior context. Send only the newest user message, not the whole array,
  // to avoid duplicating what the session has seen.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return messages.slice(i);
    }
  }
  return [];
}

function buildDeepseekPrompt(body: AnthropicRequest, isContinuation: boolean): string {
  const chunks: string[] = [];

  if (!isContinuation) {
    const systemText = extractSystemText(body.system);
    if (systemText.length > 0) {
      chunks.push(`System:\n${systemText}`);
    }
  }

  const messagesToSend = isContinuation ? extractLastTurn(body.messages) : body.messages;

  for (const message of messagesToSend) {
    const text = extractMessageText(message.content);
    if (!text) continue;

    const role = message.role === "assistant" ? "Assistant" : "User";
    chunks.push(`${role}:\n${text}`);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const toolLines = body.tools.map((tool) => {
      const desc = tool.description ? ` — ${tool.description}` : "";
      const schema = tool.input_schema ? ` schema=${toCompactJson(tool.input_schema)}` : "";
      return `- ${tool.name}${desc}${schema}`;
    });
    chunks.push(
      [
        "Tools available:",
        ...toolLines,
        "If you need to call a tool, output ONLY valid JSON in this exact shape:",
        '{"tool":"<tool_name>","arguments":{...}}',
        "No prose, no markdown fences, no fake tool results.",
      ].join("\n"),
    );
  }

  chunks.push("Assistant:");
  return chunks.join("\n\n");
}

function normalizeToolInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fencedMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.push(candidate);
    }
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function parseToolCallFromText(text: string, tools: AnthropicTool[] | undefined): ParsedToolCall | null {
  if (!Array.isArray(tools) || tools.length === 0) {
    return null;
  }

  const toolNames = new Set(tools.map((tool) => tool.name));
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    const asRecord = parsed as Record<string, unknown>;
    const rawName = typeof asRecord.tool === "string" ? asRecord.tool : typeof asRecord.name === "string" ? asRecord.name : null;
    if (!rawName || !toolNames.has(rawName)) {
      continue;
    }

    const rawInput = asRecord.arguments ?? asRecord.input ?? {};
    const input = normalizeToolInput(rawInput);
    if (!input) {
      continue;
    }

    return { name: rawName, input };
  }

  return null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function extractMessageIds(
  event: DeepseekPatchEvent,
  state: { requestMessageId: number | null; responseMessageId: number | null },
): void {
  if (!event || typeof event !== "object") return;

  const requestFromRoot = asNumberOrNull((event as { request_message_id?: unknown }).request_message_id);
  const responseFromRoot = asNumberOrNull((event as { response_message_id?: unknown }).response_message_id);

  if (requestFromRoot !== null) {
    state.requestMessageId = requestFromRoot;
  }
  if (responseFromRoot !== null) {
    state.responseMessageId = responseFromRoot;
  }

  if (event.v && typeof event.v === "object") {
    const nestedResponse = (event.v as { response?: { message_id?: unknown; parent_id?: unknown } }).response;
    const nestedMessageId = asNumberOrNull(nestedResponse?.message_id);
    const nestedParentId = asNumberOrNull(nestedResponse?.parent_id);

    if (nestedMessageId !== null) {
      state.responseMessageId = nestedMessageId;
    }
    if (nestedParentId !== null) {
      state.requestMessageId = nestedParentId;
    }
  }
}

function splitTextForSse(text: string, chunkSize = 120): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function parseStreamLine(line: string): DeepseekPatchEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }

  const raw = trimmed.slice("data:".length).trim();
  if (!raw || raw === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(raw) as DeepseekPatchEvent;
  } catch {
    return null;
  }
}

function extractResponseChunks(event: DeepseekPatchEvent, state: { fragmentType: string | null }): string[] {
  const chunks: string[] = [];

  if (event.v && typeof event.v === "object" && !event.p) {
    const nested = event.v as { response?: { fragments?: Array<{ type?: string; content?: unknown }> } };
    const fragments = nested.response?.fragments;
    if (Array.isArray(fragments) && fragments.length > 0) {
      const fragment = fragments[fragments.length - 1];
      if (!fragment) {
        return chunks;
      }
      state.fragmentType = fragment.type ?? null;
      if (state.fragmentType === "RESPONSE" && typeof fragment.content === "string" && fragment.content.length > 0) {
        chunks.push(fragment.content);
      }
      return chunks;
    }
  }

  if (event.p === "response/fragments" && event.o === "APPEND" && Array.isArray(event.v)) {
    for (const fragment of event.v) {
      if (!fragment || typeof fragment !== "object") continue;
      const typedFragment = fragment as { type?: string; content?: unknown };
      state.fragmentType = typedFragment.type ?? null;
      if (state.fragmentType === "RESPONSE" && typeof typedFragment.content === "string" && typedFragment.content.length > 0) {
        chunks.push(typedFragment.content);
      }
    }
    return chunks;
  }

  if (event.p === "response/fragments/-1/content" && typeof event.v === "string") {
    if (state.fragmentType === "RESPONSE") {
      chunks.push(event.v);
    }
    return chunks;
  }

  if (!event.p && typeof event.v === "string" && state.fragmentType === "RESPONSE") {
    chunks.push(event.v);
  }

  return chunks;
}

interface DeepseekStreamState {
  readonly idState: { requestMessageId: number | null; responseMessageId: number | null };
}

async function* streamDeepseek(
  response: Response,
  state: DeepseekStreamState,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const fragmentState: { fragmentType: string | null } = { fragmentType: null };
  let buffer = "";

  let cancelPromise: Promise<void> | null = null;
  const onAbort = () => {
    if (!cancelPromise) {
      cancelPromise = reader.cancel().catch(() => {});
    }
  };
  signal?.addEventListener("abort", onAbort);
  // Handle the case where the request was already aborted before we subscribed.
  if (signal?.aborted) {
    onAbort();
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;

        extractMessageIds(event, state.idState);
        const textChunks = extractResponseChunks(event, fragmentState);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) yield textChunk;
        }
      }
    }

    if (buffer.length > 0) {
      const event = parseStreamLine(buffer);
      if (event) {
        extractMessageIds(event, state.idState);
        const textChunks = extractResponseChunks(event, fragmentState);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) yield textChunk;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (cancelPromise) {
      await cancelPromise;
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released on cancel */
    }
  }
}

function anthropicError(message: string, status = 400): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
      },
    },
    { status },
  );
}

function getConversationKey(req: Request): string {
  const claudeSessionId = req.headers.get("x-claude-code-session-id");
  if (claudeSessionId && claudeSessionId.trim().length > 0) {
    return `claude:${claudeSessionId.trim()}`;
  }

  return "claude:default";
}

async function getConversationState(req: Request, client: DeepseekClientInstance): Promise<ConversationState> {
  const key = getConversationKey(req);
  const existing = conversationStore.get(key);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

  const session = await client.createSession();
  const created: ConversationState = {
    session,
    parentMessageId: session.getParentMessageId(),
    updatedAt: Date.now(),
  };
  conversationStore.set(key, created);
  return created;
}

async function readUpstreamError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 0 ? text.slice(0, 500) : `status ${response.status}`;
  } catch {
    return `status ${response.status}`;
  }
}

function looksLikeJsonStart(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("{")) return true;
  if (/^```(?:json)?/i.test(trimmed)) return true;
  return false;
}

const PEEK_THRESHOLD = 48;

async function handleMessages(req: Request): Promise<Response> {
  if (PROXY_API_KEY) {
    const requestApiKey = req.headers.get("x-api-key");
    if (requestApiKey !== PROXY_API_KEY) {
      return anthropicError("Invalid x-api-key", 401);
    }
  }

  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return anthropicError("Invalid JSON body");
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError("`messages` must be a non-empty array");
  }

  const client = await getClient();
  const conversation = await getConversationState(req, client);
  const isContinuation = conversation.parentMessageId != null;
  conversation.session.setParentMessageId(conversation.parentMessageId);

  const prompt = buildDeepseekPrompt(body, isContinuation);
  if (prompt.trim().length === 0 || prompt.trim() === "Assistant:") {
    return anthropicError("Prompt is empty after extracting the latest turn");
  }

  let deepseekResponse: Response;
  try {
    deepseekResponse = await client.sendMessage(prompt, conversation.session, {
      thinking_enabled: false,
      search_enabled: false,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return anthropicError(`DeepSeek request failed: ${msg}`, 502);
  }

  if (!deepseekResponse.ok) {
    const detail = await readUpstreamError(deepseekResponse);
    const status = deepseekResponse.status === 401 || deepseekResponse.status === 403 ? 401 : 502;
    const hint =
      status === 401
        ? "DeepSeek rejected the token — DEEPSEEK_TOKEN is missing, expired, or invalid."
        : `DeepSeek upstream error ${deepseekResponse.status}: ${detail}`;
    return anthropicError(hint, status);
  }

  const anthropicModel = body.model || "deepseek-chat";
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolCallId = `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  const persistIds = (idState: { requestMessageId: number | null; responseMessageId: number | null }) => {
    try {
      if (idState.responseMessageId !== null) {
        conversation.parentMessageId = idState.responseMessageId;
        conversation.session.setParentMessageId(idState.responseMessageId);
      }
      conversation.updatedAt = Date.now();
    } catch (error) {
      // Never let bookkeeping swallow a real upstream error from the caller's finally.
      console.error("persistIds failed:", error);
    }
  };

  if (!body.stream) {
    const streamState: DeepseekStreamState = {
      idState: { requestMessageId: null, responseMessageId: null },
    };
    let text = "";
    try {
      for await (const chunk of streamDeepseek(deepseekResponse, streamState, req.signal)) {
        text += chunk;
      }
    } finally {
      persistIds(streamState.idState);
    }

    const parsedToolCall = hasTools ? parseToolCallFromText(text, body.tools) : null;
    const usage = { input_tokens: 0, output_tokens: Math.max(1, Math.ceil(text.length / 4)) };

    if (parsedToolCall) {
      return Response.json({
        id: messageId,
        type: "message",
        role: "assistant",
        model: anthropicModel,
        content: [
          { type: "tool_use", id: toolCallId, name: parsedToolCall.name, input: parsedToolCall.input },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage,
      });
    }

    return Response.json({
      id: messageId,
      type: "message",
      role: "assistant",
      model: anthropicModel,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }

  const streamState: DeepseekStreamState = {
    idState: { requestMessageId: null, responseMessageId: null },
  };

  const stream = new ReadableStream<string>({
    async start(controller) {
      const send = (event: string, payload: Record<string, unknown>) => {
        writeSseEvent(controller, event, payload);
      };
      const closeController = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: anthropicModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      type Mode = "undecided" | "text" | "tool";
      let mode: Mode = hasTools ? "undecided" : "text";
      let pending = "";
      let textOpened = false;
      let textChars = 0;

      const openTextBlock = () => {
        if (textOpened) return;
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        textOpened = true;
      };

      const emitText = (text: string) => {
        if (!text) return;
        openTextBlock();
        for (const piece of splitTextForSse(text, 256)) {
          send("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: piece },
          });
        }
        textChars += text.length;
      };

      const finishAsToolUse = (name: string, input: Record<string, unknown>, tokens: number) => {
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: toolCallId, name, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: Math.max(1, tokens) },
        });
        send("message_stop", { type: "message_stop" });
        closeController();
      };

      const finishAsText = (override?: string) => {
        if (override !== undefined) {
          pending = "";
          emitText(override);
        } else if (pending.length > 0) {
          emitText(pending);
          pending = "";
        }
        if (!textOpened) openTextBlock();
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: Math.max(1, Math.ceil(textChars / 4)) },
        });
        send("message_stop", { type: "message_stop" });
        closeController();
      };

      try {
        for await (const chunk of streamDeepseek(deepseekResponse, streamState, req.signal)) {
          if (mode === "text") {
            emitText(chunk);
            continue;
          }

          pending += chunk;

          if (mode === "undecided") {
            const trimmed = pending.trimStart();
            if (trimmed.length === 0) continue;
            if (looksLikeJsonStart(pending)) {
              mode = "tool";
            } else if (trimmed.length >= PEEK_THRESHOLD) {
              mode = "text";
              emitText(pending);
              pending = "";
            }
          }
        }

        if (mode === "tool") {
          const parsed = parseToolCallFromText(pending, body.tools);
          if (parsed) {
            finishAsToolUse(parsed.name, parsed.input, Math.ceil(pending.length / 4));
          } else {
            // Model tried to emit a tool call but produced invalid JSON.
            // Don't forward the broken payload to the client as text —
            // substitute a short error string.
            finishAsText("[tool_call_parse_failed]");
          }
        } else {
          finishAsText();
        }
      } catch (error) {
        send("error", {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : "Streaming failed",
          },
        });
        closeController();
      } finally {
        persistIds(streamState.idState);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "anthropic-deepseek-bridge" });
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return handleMessages(req);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Bridge is running on http://localhost:${server.port}`);
