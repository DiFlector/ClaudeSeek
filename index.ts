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

interface DeepseekCollectedOutput {
  text: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
}

interface ConversationState {
  session: DeepseekSession;
  parentMessageId: number | null;
  updatedAt: number;
}

const PORT = Number(process.env.PORT ?? "4141");
const TOKEN = process.env.DEEPSEEK_TOKEN;
const PROXY_API_KEY = process.env.PROXY_API_KEY;

if (!TOKEN) {
  throw new Error("Missing DEEPSEEK_TOKEN in environment");
}

let clientPromise: Promise<DeepseekClientInstance> | null = null;
const conversationStore = new Map<string, ConversationState>();

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

function buildDeepseekPrompt(body: AnthropicRequest): string {
  const chunks: string[] = [];
  const systemText = extractSystemText(body.system);
  if (systemText.length > 0) {
    chunks.push(`System:\n${systemText}`);
  }

  for (const message of body.messages) {
    const text = extractMessageText(message.content);
    if (!text) continue;

    const role = message.role === "assistant" ? "Assistant" : "User";
    chunks.push(`${role}:\n${text}`);
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const toolNames = body.tools.map((tool) => tool.name).join(", ");
    chunks.push(
      [
        "Tools available:",
        toolNames,
        'If you need to call a tool, output ONLY valid JSON in this exact shape:',
        '{"tool":"<tool_name>","arguments":{...}}',
        "Do not add markdown fences, explanations, or fake tool results.",
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

async function collectDeepseekOutput(response: Response): Promise<DeepseekCollectedOutput> {
  let text = "";
  const idState: { requestMessageId: number | null; responseMessageId: number | null } = {
    requestMessageId: null,
    responseMessageId: null,
  };

  if (!response.body) {
    return {
      text,
      requestMessageId: idState.requestMessageId,
      responseMessageId: idState.responseMessageId,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunkState: { fragmentType: string | null } = { fragmentType: null };
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;

        extractMessageIds(event, idState);
        const textChunks = extractResponseChunks(event, chunkState);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) {
            text += textChunk;
          }
        }
      }
    }

    if (buffer.length > 0) {
      const event = parseStreamLine(buffer);
      if (event) {
        extractMessageIds(event, idState);
        const textChunks = extractResponseChunks(event, chunkState);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) {
            text += textChunk;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text,
    requestMessageId: idState.requestMessageId,
    responseMessageId: idState.responseMessageId,
  };
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

async function* deepseekToTextDeltas(response: Response): AsyncGenerator<string, void, void> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: { fragmentType: string | null } = { fragmentType: null };
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;

        const textChunks = extractResponseChunks(event, state);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) {
            yield textChunk;
          }
        }
      }
    }

    if (buffer.length > 0) {
      const event = parseStreamLine(buffer);
      if (event) {
        const textChunks = extractResponseChunks(event, state);
        for (const textChunk of textChunks) {
          if (textChunk.length > 0) {
            yield textChunk;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
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

  const prompt = buildDeepseekPrompt(body);
  const client = await getClient();
  const conversation = await getConversationState(req, client);
  conversation.session.setParentMessageId(conversation.parentMessageId);

  const deepseekResponse = await client.sendMessage(prompt, conversation.session, {
    thinking_enabled: false,
    search_enabled: false,
  });

  if (!deepseekResponse.ok) {
    return anthropicError(`DeepSeek upstream failed with status ${deepseekResponse.status}`, 502);
  }

  const anthropicModel = body.model || "deepseek-chat";
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const toolCallId = `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
  const deepseekOutput = await collectDeepseekOutput(deepseekResponse);
  const text = deepseekOutput.text;
  const parsedToolCall = parseToolCallFromText(text, body.tools);

  if (deepseekOutput.responseMessageId !== null) {
    conversation.parentMessageId = deepseekOutput.responseMessageId;
    conversation.session.setParentMessageId(deepseekOutput.responseMessageId);
    conversation.updatedAt = Date.now();
  }

  if (body.stream) {
    const stream = new ReadableStream<string>({
      async start(controller) {
        writeSseEvent(controller, "message_start", {
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

        try {
          if (parsedToolCall) {
            writeSseEvent(controller, "content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: toolCallId,
                name: parsedToolCall.name,
                input: {},
              },
            });

            writeSseEvent(controller, "content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(parsedToolCall.input),
              },
            });

            writeSseEvent(controller, "content_block_stop", {
              type: "content_block_stop",
              index: 0,
            });

            writeSseEvent(controller, "message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: Math.ceil(text.length / 4) },
            });
          } else {
            writeSseEvent(controller, "content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });

            for (const textChunk of splitTextForSse(text)) {
              writeSseEvent(controller, "content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "text_delta",
                  text: textChunk,
                },
              });
            }

            writeSseEvent(controller, "content_block_stop", {
              type: "content_block_stop",
              index: 0,
            });

            writeSseEvent(controller, "message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: Math.ceil(text.length / 4) },
            });
          }

          writeSseEvent(controller, "message_stop", { type: "message_stop" });
          controller.close();
        } catch (error) {
          writeSseEvent(controller, "error", {
            type: "error",
            error: {
              type: "api_error",
              message: error instanceof Error ? error.message : "Streaming failed",
            },
          });
          controller.close();
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

  if (parsedToolCall) {
    return Response.json({
      id: messageId,
      type: "message",
      role: "assistant",
      model: anthropicModel,
      content: [
        {
          type: "tool_use",
          id: toolCallId,
          name: parsedToolCall.name,
          input: parsedToolCall.input,
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: Math.ceil(text.length / 4),
      },
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
    usage: {
      input_tokens: 0,
      output_tokens: Math.ceil(text.length / 4),
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
