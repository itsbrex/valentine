// LFM2.5 output plumbing, shared by the local providers (Ollama fallback +
// ONNX). The model reasons inside <think>…</think> and emits Pythonic tool
// calls — func(arg="value") — between <|tool_call_start|>/<|tool_call_end|>
// special tokens. Some variants emit the JSON form {"name":…, "arguments":…}
// instead, so that is tried first.

export interface LfmToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Remove <think> spans, including an unclosed trailing one (truncation) and a
 *  dangling close with no opener — chat templates that pre-fill the opening
 *  <think> token (LFM2.5's does) make generation start mid-reasoning, so the
 *  raw output looks like "…reasoning</think>the actual answer". */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    .trim();
}

const CALL_RE = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g;

/** Extract every tool-call span; returns remaining prose + parsed calls. */
export function parseLfmToolCalls(text: string): { text: string; calls: LfmToolCall[] } {
  const calls: LfmToolCall[] = [];
  const rest = text.replace(CALL_RE, (_, body: string) => {
    calls.push(...parseCallSpan(body.trim()));
    return "";
  });
  return { text: rest.trim(), calls };
}

/** One marker span → zero or more calls. LFM2.5 emits a Python *list* —
 *  `[search_crm(domain='acme.com')]` (verified against the real model) — but
 *  a bare `func(...)` and the JSON form both show up too. */
function parseCallSpan(body: string): LfmToolCall[] {
  try {
    const parsed = JSON.parse(body);
    const items = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (j) => j && typeof j.name === "string",
    );
    if (items.length)
      return items.map((j) => ({
        name: j.name as string,
        input: (j.arguments ?? j.parameters ?? {}) as Record<string, unknown>,
      }));
  } catch {
    /* not the JSON form — try Pythonic */
  }
  const listed = /^\[([\s\S]*)\]$/.exec(body);
  return splitTopLevel(listed ? listed[1] : body)
    .map(parseCall)
    .filter((c): c is LfmToolCall => c !== null);
}

/** Split on commas at nesting depth 0, ignoring those inside quotes. */
function splitTopLevel(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function parseCall(body: string): LfmToolCall | null {
  const m = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)$/.exec(body);
  if (!m) return null;
  return { name: m[1], input: parseArgs(m[2]) };
}

/** Parse `key=value, …` with quoted strings, numbers, bools, None, [] / {}. */
function parseArgs(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  while (i < src.length) {
    skipWs();
    const key = /^[A-Za-z_]\w*/.exec(src.slice(i))?.[0];
    // A positional or otherwise unkeyed token: consume it and keep scanning.
    // Abandoning here would drop every later key=value pair too, turning a
    // usable tool call into a silent no-arg one.
    if (!key) {
      i = Math.max(parseValue(src, i)[1], i + 1);
      skipWs();
      if (src[i] === ",") i++;
      continue;
    }
    i += key.length;
    skipWs();
    if (src[i] !== "=") break;
    i++;
    skipWs();
    const [value, next] = parseValue(src, i);
    out[key] = value;
    i = next;
    skipWs();
    if (src[i] === ",") i++;
  }
  return out;
}

function parseValue(src: string, i: number): [unknown, number] {
  const c = src[i];
  if (c === '"' || c === "'") {
    let s = "";
    let j = i + 1;
    while (j < src.length && src[j] !== c) {
      if (src[j] === "\\" && j + 1 < src.length) {
        s += src[j + 1];
        j += 2;
      } else s += src[j++];
    }
    return [s, j + 1];
  }
  if (c === "[" || c === "{") {
    // Take the balanced fragment, then JSON-parse (with Pythonic fixups).
    let depth = 0;
    let inStr: string | null = null;
    let j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        if (--depth === 0) {
          j++;
          break;
        }
      }
    }
    const frag = src.slice(i, j);
    try {
      return [JSON.parse(frag), j];
    } catch {
      try {
        return [JSON.parse(pythonToJson(frag)), j];
      } catch {
        return [frag, j];
      }
    }
  }
  let j = i;
  while (j < src.length && !/[,)\s]/.test(src[j])) j++;
  const tok = src.slice(i, j);
  if (tok === "true" || tok === "True") return [true, j];
  if (tok === "false" || tok === "False") return [false, j];
  if (tok === "null" || tok === "None") return [null, j];
  const num = Number(tok);
  return [Number.isNaN(num) ? tok : num, j];
}

/** Best-effort Python-literal → JSON: quotes, True/False/None. */
const pythonToJson = (s: string) =>
  s
    .replace(/'/g, '"')
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
