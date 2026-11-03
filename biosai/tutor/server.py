"""AI tutor backend.

  python -m biosai serve --schema out/z890-eagle-f5/bios_schema.json --board boards/gigabyte-z890-eagle-wifi7

Endpoints
  GET  /api/status          -> whether Claude is reachable, model, board
  POST /api/chat            -> Server-Sent Events stream of the tutor's answer
  POST /api/reset           -> forget a conversation

Claude answers are grounded in the extracted BIOS (retrieved options with real
menu paths, choices, defaults and dependency rules) plus kb/tuning_guide.md.
Without credentials the endpoint still answers, from the BIOS data alone.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, AsyncIterator

import anthropic
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .knowledge import Board, Index, describe_item, item_path, load_board

MODEL = "claude-opus-5-5"
MAX_HISTORY_MESSAGES = 40

ROOT = Path(__file__).resolve().parents[2]

RULES = """You are the AI tutor inside "BIOS AI", an emulator of a real motherboard's UEFI setup.
The user is learning how BIOS options work and how to tune their PC (overclocking, undervolting, memory, fans, boot and security settings).

How to answer:
- Latency-sensitive: begin your visible answer immediately.
- Be practical and concise. Use short paragraphs and numbered steps for procedures. Plain language first, then the technical detail.
- Ground every option name, menu location, choice and default in the BIOS context supplied with each message. Those come from this board's actual firmware. If an option the user asks about isn't in the context, say you can't find it on this board rather than inventing one.
- When you mention a specific option from the context, add a link marker right after its name: [[item:ID]] using the exact id from the context (e.g. "Set Extreme Memory Profile(X.M.P.) [[item:4:10739/16]] to XMP 1"). The app turns these into "show me" buttons. Only use ids that appear in the context.
- Tailor advice to the user's selected hardware (CPU, memory kit, storage, GPU). Note when something doesn't apply (e.g. ratio overclocking on a non-K CPU, XMP on a kit without XMP, no display output on a KF CPU without a GPU).
- Live readings (frequency, temperature, voltage) are simulated by the emulator; say so if the user treats them as real measurements.
- Safety: this emulator never touches real hardware. For real systems, recommend one change at a time, stress testing, watching temperatures, and how to recover (Clear CMOS). Give conservative voltage guidance and call it guidance, not a specification. Never encourage disabling thermal protection.
- Numeric options on this board show 0 as "Auto".

Background knowledge (general; board facts in the per-message context take precedence):

"""


def _system_prompt(board: Board) -> str:
    kb_path = ROOT / "kb" / "tuning_guide.md"
    kb = kb_path.read_text(encoding="utf-8") if kb_path.exists() else ""
    tabs = ", ".join(t["title"] for t in board.layout["tabs"])
    meta = board.schema["meta"]
    return (RULES + kb + f"\n\nThis board: {board.name}, firmware file {meta.get('source_file')} "
            f"({meta.get('vendor_firmware')}). GUI tabs: {tabs}.")


def load_dotenv(path: Path) -> list[str]:
    """Minimal .env reader (KEY=VALUE lines). Real environment variables win.
    Returns the names it set, never the values."""
    loaded = []
    if not path.exists():
        return loaded
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and not os.environ.get(k):
            os.environ[k] = v
            loaded.append(k)
    return loaded


def _credentials_present() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    return (Path.home() / ".config" / "anthropic").exists()


def build_context(board: Board, index: Index, body: dict) -> tuple[str, list[str]]:
    hw = body.get("hardware") or {}
    sim = body.get("readings") or {}
    changes = body.get("changes") or []
    focus = body.get("focus_iid")
    question = body.get("message", "")
    current = {c["iid"]: f"{c.get('to')} (was {c.get('from')})" for c in changes if c.get("iid")}

    query = question
    if focus and focus in board.schema["items"]:
        query += " " + (board.schema["items"][focus].get("prompt") or "")
    hits = index.search(query, k=24)
    for c in changes:
        if c.get("iid") in board.schema["items"] and c["iid"] not in hits:
            hits.append(c["iid"])

    lines = ["<bios_context>", "Selected hardware:"]
    for k in ("cpu", "memory", "storage", "gpu"):
        if hw.get(k):
            lines.append(f"- {k}: {hw[k]}")
    if sim:
        lines.append("Simulated live readings: " + ", ".join(f"{k}={v}" for k, v in sim.items()))
    if body.get("page_path"):
        lines.append(f"User is viewing: {body['page_path']}")
    if focus and focus in board.schema["items"]:
        lines.append("Option the user is asking about (full detail):")
        lines.append("- " + describe_item(board, focus, current, full=True))
    if changes:
        lines.append("Unsaved changes the user made in the emulator:")
        for c in changes:
            lines.append(f"- {c.get('path')}: {c.get('from')} -> {c.get('to')}" + (f" [{c['iid']}]" if c.get("iid") else ""))
    lines.append("Related options on this board (id, menu path, details):")
    for iid in hits:
        if iid != focus:
            lines.append("- " + describe_item(board, iid, current, full=False))
    lines.append("</bios_context>")
    return "\n".join(lines), hits


def offline_answer(board: Board, body: dict, hits: list[str]) -> str:
    """Deterministic answer from BIOS data when Claude isn't configured."""
    focus = body.get("focus_iid")
    out = []
    if focus and focus in board.schema["items"]:
        d = board.schema["items"][focus]
        path = item_path(board, focus)
        out.append(f"**{d.get('prompt')}** [[item:{focus}]]")
        if path:
            out.append(f"Location: {' › '.join(path)}")
        if d.get("help"):
            out.append(d["help"])
        if d["kind"] == "oneof" and d.get("options"):
            out.append("Choices: " + ", ".join(o["label"] + (" (default)" if o.get("default") else "") for o in d["options"]))
        if d["kind"] == "numeric":
            out.append(f"Range {d.get('min')}–{d.get('max')} (0 = Auto).")
        detail = describe_item(board, focus, full=True)
        deps = [p for p in detail.split("; ") if p.startswith(("hidden when", "greyed when"))]
        if deps:
            out.append("Depends on:\n" + "\n".join(f"- {p}" for p in deps))
    others = [h for h in hits if h != focus][:8]
    if others:
        out.append("Related options on this board:\n" + "\n".join(
            f"- {board.schema['items'][h].get('prompt')} [[item:{h}]] — {' › '.join(item_path(board, h) or ['hidden menu'])}" for h in others))
    out.append("Offline mode: this answer comes from the BIOS's own help text. For full AI tutoring (explanations, overclocking and undervolting walkthroughs), click **Connect Claude** at the top of this panel.")
    return "\n\n".join(out)


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


def create_app(schema_path: str, board_dir: str) -> FastAPI:
    global MODEL
    loaded = load_dotenv(ROOT / ".env")
    if loaded:
        print(f"[biosai] loaded from .env: {', '.join(loaded)}")
    MODEL = os.environ.get("BIOSAI_MODEL", MODEL)
    board = load_board(schema_path, board_dir)
    index = Index(board)
    system_text = _system_prompt(board)
    conversations: dict[str, list[dict[str, Any]]] = {}
    locks: dict[str, asyncio.Lock] = {}
    state = {"ai": _credentials_present()}
    client = anthropic.AsyncAnthropic() if state["ai"] else None

    app = FastAPI(title="BIOS AI tutor")

    @app.get("/api/status")
    async def status() -> dict:
        return {"ai": state["ai"], "model": MODEL if state["ai"] else None, "board": board.name}

    @app.post("/api/connect")
    async def connect(req: Request):
        """Save an Anthropic API key from the local UI: verify it, write .env, go online."""
        nonlocal client
        if req.client is None or req.client.host not in ("127.0.0.1", "::1", "localhost"):
            return JSONResponse({"ok": False, "error": "Only allowed from this computer."}, status_code=403)
        body = await req.json()
        key = str(body.get("api_key", "")).strip()
        if not key.startswith("sk-ant-") or len(key) < 40 or any(c.isspace() for c in key):
            return JSONResponse({"ok": False, "error": "That doesn't look like an Anthropic API key (it starts with sk-ant-)."}, status_code=400)
        candidate = anthropic.AsyncAnthropic(api_key=key)
        try:
            await candidate.models.retrieve(MODEL)  # free call: proves the key works and can use the model
        except anthropic.AuthenticationError:
            return JSONResponse({"ok": False, "error": "Anthropic rejected this key. Check it was copied completely."}, status_code=400)
        except anthropic.PermissionDeniedError:
            return JSONResponse({"ok": False, "error": f"This key can't access {MODEL}."}, status_code=400)
        except anthropic.NotFoundError:
            return JSONResponse({"ok": False, "error": f"Model {MODEL} isn't available to this key."}, status_code=400)
        except anthropic.APIConnectionError:
            return JSONResponse({"ok": False, "error": "Couldn't reach the Anthropic API. Check your internet connection."}, status_code=502)
        except anthropic.APIStatusError as e:
            return JSONResponse({"ok": False, "error": f"Anthropic API error {e.status_code}."}, status_code=502)
        env_path = ROOT / ".env"
        lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        lines = [l for l in lines if not l.strip().startswith("ANTHROPIC_API_KEY")] + [f"ANTHROPIC_API_KEY={key}"]
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.environ["ANTHROPIC_API_KEY"] = key
        client = candidate
        state["ai"] = True
        return {"ok": True, "model": MODEL}

    @app.post("/api/reset")
    async def reset(req: Request) -> dict:
        body = await req.json()
        conversations.pop(body.get("conversation_id", ""), None)
        return {"ok": True}

    async def stream_answer(body: dict) -> AsyncIterator[bytes]:
        context, hits = build_context(board, index, body)
        if not state["ai"] or client is None:
            yield _sse({"type": "meta", "mode": "offline"})
            yield _sse({"type": "text", "text": offline_answer(board, body, hits)})
            yield _sse({"type": "done"})
            return

        cid = str(body.get("conversation_id") or "default")
        lock = locks.setdefault(cid, asyncio.Lock())
        async with lock:
            history = conversations.setdefault(cid, [])
            if len(history) >= MAX_HISTORY_MESSAGES:
                history.clear()  # start a fresh thread rather than editing an old one
            user_turn = {"role": "user", "content": [
                {"type": "text", "text": context},
                {"type": "text", "text": body.get("message", "")},
            ]}
            messages = history + [user_turn]
            yield _sse({"type": "meta", "mode": "ai", "model": MODEL})
            try:
                async with client.beta.messages.stream(
                    model=MODEL,
                    max_tokens=16000,
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                    output_config={"effort": "medium"},
                    system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
                    messages=messages,
                ) as stream:
                    async for text in stream.text_stream:
                        yield _sse({"type": "text", "text": text})
                    final = await stream.get_final_message()
                if final.stop_reason == "refusal":
                    yield _sse({"type": "text", "text": "\n\n_The assistant declined to answer this one. Try rephrasing the question._"})
                    # nothing appended: the history stays exactly as it was
                else:
                    history.append(user_turn)
                    history.append({"role": "assistant", "content": final.content})
                    if final.stop_reason == "max_tokens":
                        yield _sse({"type": "text", "text": "\n\n_(answer cut off: ask me to continue)_"})
                yield _sse({"type": "done"})
            except anthropic.AuthenticationError:
                state["ai"] = False
                yield _sse({"type": "meta", "mode": "offline"})
                yield _sse({"type": "text", "text": "The API key was rejected, so I switched to offline mode.\n\n" + offline_answer(board, body, hits)})
                yield _sse({"type": "done"})
            except anthropic.RateLimitError:
                yield _sse({"type": "error", "message": "Rate limited by the Claude API. Wait a moment and try again."})
            except anthropic.APIStatusError as e:
                yield _sse({"type": "error", "message": f"Claude API error {e.status_code}: {e.message}"})
            except anthropic.APIConnectionError:
                yield _sse({"type": "error", "message": "Couldn't reach the Claude API. Check your internet connection."})

    @app.post("/api/chat")
    async def chat(req: Request):
        body = await req.json()
        if not isinstance(body.get("message"), str) or not body["message"].strip():
            return JSONResponse({"error": "message required"}, status_code=400)
        body["message"] = body["message"][:4000]
        if body.get("focus_iid") and not re.fullmatch(r"\d+:\d+/\d+", str(body["focus_iid"])):
            body["focus_iid"] = None
        return StreamingResponse(stream_answer(body), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    dist = ROOT / "app" / "dist"
    if dist.exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="app")
    return app
