import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { Item, Schema } from "./types";
import { RULES, type Tutor } from "./tutor";

// The claude.ai Artifact runtime's `sample` capability (asks Claude on the viewer's own account).
type SampleFn = ((input: string | { role: "user" | "assistant"; content: string }[], opts?: {
  onText?: (u: { text: string; delta: string }) => void; signal?: AbortSignal; cache?: boolean; modelTier?: string;
}) => Promise<{ text: string; truncated: boolean }>);
interface SampleError { code: string; message: string; text?: string }
declare global { interface Window { claude?: { use: (name: string) => Promise<unknown> } } }

const SAMPLE_ERRORS: Record<string, string> = {
  not_granted: "You haven't allowed this page to use Claude, so the AI assistant is off for this visit. Reload the page to be asked again.",
  sampling_disabled: "Claude isn't available for your account here.",
  rate_limited: "Too many questions at once, or your Claude usage limit was reached. Wait a moment and ask again.",
  session_expired: "Your claude.ai session expired. Sign in again and reload.",
  refused: "Claude declined to answer that. Try rephrasing the question.",
  empty_completion: "Claude returned an empty answer. Try asking in a different way.",
  prompt_too_large: "The question plus BIOS context was too large. Start a new chat and ask again.",
  upstream_error: "The connection to Claude dropped. Ask again.",
};

export interface AskContext {
  hardware: Record<string, string>;
  readings: Record<string, string>;
  page_path: string;
  changes: { iid: string; path: string; from: string; to: string }[];
}

export interface AiPanelHandle { ask: (message: string, focusIid?: string) => void }

interface Msg { role: "user" | "assistant"; text: string; error?: boolean; pending?: boolean }

interface Props {
  schema: Schema;
  tutor: Tutor;
  getContext: () => AskContext;
  selected?: { iid: string; item: Item; details: ReactNode };
  onGoto: (iid: string) => void;
}

const SUGGESTIONS = [
  "How do I enable XMP for my memory?",
  "Walk me through a safe CPU undervolt",
  "How do I overclock my P-cores?",
  "Make my PC quieter without losing performance",
];

function newId() {
  try { return crypto.randomUUID(); } catch { return `c${Date.now()}${Math.random().toString(16).slice(2)}`; }
}

export const AiPanel = forwardRef<AiPanelHandle, Props>(function AiPanel({ schema, tutor, getContext, selected, onGoto }, ref) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // ai/offline/down: local Python server; artifact: claude.ai page asking Claude directly;
  // unavailable: hosted page where Claude can't be used in this view
  const [mode, setMode] = useState<"ai" | "offline" | "down" | "unknown" | "artifact" | "unavailable">("unknown");
  const sampleRef = useRef<SampleFn | null>(null);
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const kbRef = useRef<string | null>(null);
  const ctlRef = useRef<AbortController | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [showSel, setShowSel] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [connectMsg, setConnectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    setConnectMsg(null);
    try {
      const res = await fetch("/api/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: keyInput.trim() }) });
      const j = await res.json();
      if (j.ok) {
        setMode("ai"); setModel(j.model); setKeyInput(""); setConnectOpen(false);
        setConnectMsg({ ok: true, text: `Connected to ${j.model}. The key is saved in D:\\BIOSAI\\.env on this computer.` });
      } else setConnectMsg({ ok: false, text: j.error ?? "Couldn't connect." });
    } catch {
      setConnectMsg({ ok: false, text: "Can't reach the local server. Is `biosai serve` running?" });
    } finally {
      setConnecting(false);
    }
  };
  const convo = useRef(newId());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const host = window.claude;
      if (host?.use) {
        // Published as a claude.ai Artifact: ask Claude through the page runtime
        const s = (await host.use("sample").catch(() => null)) as SampleFn | null;
        if (!live) return;
        if (typeof s === "function") { sampleRef.current = s; setMode("artifact"); return; }
        setMode("unavailable");
        return;
      }
      fetch("/api/status").then((r) => r.json()).then((s) => { if (live) { setMode(s.ai ? "ai" : "offline"); setModel(s.model); } })
        .catch(() => live && setMode("down"));
    })();
    return () => { live = false; };
  }, []);

  const loadKb = async () => {
    if (kbRef.current !== null) return kbRef.current;
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}data/kb.md`);
      kbRef.current = r.ok ? await r.text() : "";
    } catch { kbRef.current = ""; }
    return kbRef.current;
  };

  /** One question through the Artifact runtime. The page keeps the conversation;
   *  only the newest user turn carries the (large) BIOS context. */
  const askViaArtifact = async (message: string, focusIid: string | undefined, patchLast: (f: (m: Msg) => Msg) => void) => {
    const sample = sampleRef.current!;
    const context = tutor.context({ message, focus_iid: focusIid ?? null, ...getContext() });
    const rules = RULES + (await loadKb()) + tutor.boardLine();
    const history = historyRef.current.slice(-8);
    const turns = [{ role: "user" as const, content: rules }, ...history, { role: "user" as const, content: `${context}\n\nQuestion: ${message}` }];
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      const { text, truncated } = await sample(turns, {
        cache: false, signal: ctl.signal,
        onText: ({ text: t }) => patchLast((m) => ({ ...m, text: t })),
      });
      patchLast((m) => ({ ...m, text: text + (truncated ? "\n\n(The answer was cut short. Ask me to continue.)" : ""), pending: false }));
      historyRef.current = [...historyRef.current, { role: "user", content: message }, { role: "assistant", content: text }];
    } catch (err) {
      const e = err as SampleError;
      if (e.code === "cancelled") { patchLast((m) => ({ ...m, text: e.text ?? m.text, pending: false })); return; }
      if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(e.code)) setMode("unavailable");
      const keep = e.code === "refused" ? "" : e.text ?? "";
      patchLast(() => ({ role: "assistant", pending: false, error: true,
        text: (keep ? keep + "\n\n" : "") + (SAMPLE_ERRORS[e.code] ?? SAMPLE_ERRORS.upstream_error) }));
    } finally {
      ctlRef.current = null;
    }
  };

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [msgs]);

  const ask = async (message: string, focusIid?: string) => {
    if (!message.trim() || busy) return;
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: message }, { role: "assistant", text: "", pending: true }]);
    const patchLast = (f: (m: Msg) => Msg) => setMsgs((all) => [...all.slice(0, -1), f(all[all.length - 1])]);
    if (sampleRef.current) {
      try { await askViaArtifact(message, focusIid, patchLast); } finally { setBusy(false); }
      return;
    }
    if (mode === "unavailable") {
      patchLast(() => ({ role: "assistant", pending: false, error: true,
        text: "The AI assistant isn't available in this view. Open the page on claude.ai while signed in and allow it to use Claude." }));
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: convo.current, message, focus_iid: focusIid ?? null, ...getContext() }),
      });
      if (!res.ok || !res.body) throw new Error(`server returned ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, cut).replace(/^data: /, "");
          buf = buf.slice(cut + 2);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "text") patchLast((m) => ({ ...m, text: m.text + ev.text }));
          else if (ev.type === "meta") { setMode(ev.mode); if (ev.model) setModel(ev.model); }
          else if (ev.type === "error") patchLast((m) => ({ ...m, text: m.text + (m.text ? "\n\n" : "") + ev.message, error: true }));
        }
      }
      patchLast((m) => ({ ...m, pending: false }));
    } catch (e) {
      setMode("down");
      patchLast(() => ({ role: "assistant", pending: false, error: true,
        text: `Can't reach the AI server (${String(e)}). Start it with \`uv run python -m biosai serve\` and reload.` }));
    } finally {
      setBusy(false);
    }
  };

  useImperativeHandle(ref, () => ({ ask }));

  const reset = () => {
    ctlRef.current?.abort();
    if (!sampleRef.current) {
      fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: convo.current }) }).catch(() => {});
    }
    historyRef.current = [];
    convo.current = newId();
    setMsgs([]);
  };

  const local = mode === "ai" || mode === "offline" || mode === "down";
  const badge = mode === "artifact" ? "Claude · your account" : mode === "ai" ? model ?? "Claude" : mode === "offline" ? "offline (BIOS data only)"
    : mode === "down" ? "server not running" : mode === "unavailable" ? "AI unavailable here" : "…";
  const badgeCls = mode === "artifact" ? "ai" : mode === "unavailable" ? "down" : mode;

  return (
    <aside className="ai">
      <div className="ai-head">
        <div><b>AI Assistant</b> <span className={`badge ${badgeCls}`}>{badge}</span></div>
        <div className="head-actions">
          {busy && ctlRef.current && <button className="link-btn" onClick={() => ctlRef.current?.abort()}>Stop</button>}
          {local && mode !== "ai" && <button className="connect-btn" onClick={() => setConnectOpen((o) => !o)}>Connect Claude</button>}
          {msgs.length > 0 && <button className="link-btn" onClick={reset}>New chat</button>}
        </div>
      </div>

      {connectOpen && local && mode !== "ai" && (
        <form className="connect" onSubmit={(e) => { e.preventDefault(); if (keyInput.trim()) connect(); }}>
          <label>Anthropic API key</label>
          <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={keyInput}
            onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setKeyInput(e.target.value)} />
          <button type="submit" disabled={connecting || !keyInput.trim()}>{connecting ? "Checking…" : "Connect"}</button>
          <p className="muted">Create a key at console.anthropic.com → API keys. API usage is billed separately from a claude.ai plan. The key is checked with Anthropic, then saved only in <code>.env</code> on this computer.</p>
        </form>
      )}
      {connectMsg && <p className={connectMsg.ok ? "connect-note ok" : "connect-note err"}>{connectMsg.text}</p>}

      {selected && (
        <div className="sel-card">
          <button className="sel-toggle" onClick={() => setShowSel((s) => !s)}>
            <span>{showSel ? "▾" : "▸"} Selected: <b>{selected.item.prompt}</b></span>
          </button>
          {showSel && <div className="sel-body">{selected.details}
            <button className="ask-sel" disabled={busy} onClick={() => ask(`What does "${selected.item.prompt}" do, and when should I change it?`, selected.iid)}>✦ Ask AI about this option</button>
          </div>}
        </div>
      )}

      <div className="ai-log" ref={scroller}>
        {msgs.length === 0 && (
          <div className="ai-empty">
            <p>Ask me what any setting does, or how to tune this system. Hover over a row and click <b>Ask AI</b> to ask about that option.</p>
            <div className="chips">{SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)}>{s}</button>)}</div>
            {mode === "offline" && <p className="muted">Running offline: answers come from this BIOS's own help text. Click <b>Connect Claude</b> above for full AI tutoring.</p>}
            {mode === "artifact" && <p className="muted">Answers use your own Claude account. The first question asks your permission.</p>}
            {mode === "unavailable" && <p className="muted">The AI assistant needs claude.ai: open this page there while signed in. The emulator itself works without it.</p>}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.error ? " err" : ""}`}>
            {m.role === "assistant" ? <Markdown text={m.text} schema={schema} onGoto={onGoto} /> : m.text}
            {m.pending && !m.text && <span className="typing">Thinking…</span>}
          </div>
        ))}
      </div>

      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); const q = input; setInput(""); ask(q); }}>
        <textarea value={input} placeholder="Ask about overclocking, undervolting, memory, fans…" rows={2}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const q = input; setInput(""); ask(q); } }}
          onChange={(e) => setInput(e.target.value)} />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </aside>
  );
});

// ---- tiny, safe markdown renderer (no HTML injection) ---------------------------
function inline(text: string, schema: Schema, onGoto: (iid: string) => void, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // _italic_ only at word boundaries, so names like ANTHROPIC_API_KEY stay intact
  const re = /\[\[item:([0-9]+:[0-9]+\/[0-9]+)\]\]|\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w])_([^_\n]+)_(?![\w])/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) {
      const iid = m[1]; // capture now: `m` is reassigned by the loop and is null when the button is clicked
      const it = schema.items[iid];
      if (it) out.push(<button key={k} className="goto" title="Show this option in the BIOS" onClick={() => onGoto(iid)}>↗ {it.prompt?.trim() || "show"}</button>);
    } else if (m[2]) out.push(<b key={k}>{m[2]}</b>);
    else if (m[3]) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4]) out.push(<em key={k}>{m[4]}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text, schema, onGoto }: { text: string; schema: Schema; onGoto: (iid: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = (k: number) => {
    if (!list) return;
    const items = list.items.map((t, i) => <li key={i}>{inline(t, schema, onGoto, `l${k}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={`o${k}`}>{items}</ol> : <ul key={`u${k}`}>{items}</ul>);
    list = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)/.exec(line);
    if (ol || ul) {
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { flush(i); list = { ordered, items: [] }; }
      list.items.push((ol ?? ul)![1]);
      return;
    }
    flush(i);
    if (!line.trim()) return;
    const h = /^#{1,4}\s+(.*)/.exec(line);
    if (h) blocks.push(<h5 key={i}>{inline(h[1], schema, onGoto, `h${i}`)}</h5>);
    else blocks.push(<p key={i}>{inline(line, schema, onGoto, `p${i}`)}</p>);
  });
  flush(lines.length);
  return <>{blocks}</>;
}
