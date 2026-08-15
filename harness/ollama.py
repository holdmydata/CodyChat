"""Minimal Ollama client: stdlib only, no dependencies.

Mirrors ui/src/lib/ollama.ts's contract (list_models, stream_chat) so the
same mental model applies on both sides of this project.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable

DEFAULT_BASE_URL = "http://localhost:11434"


class OllamaError(Exception):
    pass


@dataclass
class ChatParams:
    temperature: float = 0.8
    top_p: float = 0.9
    num_ctx: int = 4096


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant"
    content: str


def list_models(base_url: str = DEFAULT_BASE_URL) -> list[dict]:
    req = urllib.request.Request(f"{base_url}/api/tags")
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise OllamaError(f"Failed to list models: {exc}") from exc
    return data.get("models", [])


def stream_chat(
    model: str,
    messages: Iterable[Message],
    params: ChatParams = ChatParams(),
    base_url: str = DEFAULT_BASE_URL,
    on_token: Callable[[str], None] | None = None,
) -> str:
    """Streams a chat completion, calling on_token for each content delta.

    Returns the full assembled response text once the stream ends.
    """
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": {
                "temperature": params.temperature,
                "top_p": params.top_p,
                "num_ctx": params.num_ctx,
            },
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    full = ""
    try:
        with urllib.request.urlopen(req) as resp:
            for line in resp:
                line = line.strip()
                if not line:
                    continue
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise OllamaError(chunk["error"])
                token = chunk.get("message", {}).get("content", "")
                if token:
                    full += token
                    if on_token:
                        on_token(token)
    except urllib.error.URLError as exc:
        raise OllamaError(f"Chat request failed: {exc}") from exc

    return full


def chat(
    model: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    params: ChatParams = ChatParams(),
    base_url: str = DEFAULT_BASE_URL,
) -> dict:
    """Non-streaming chat call. Returns the raw response `message` dict
    (content, and tool_calls if the model requested any).

    Callers build `messages` as plain dicts rather than Message instances —
    tool-calling turns (assistant tool_calls, "tool" role results) don't
    fit the simple role/content shape stream_chat uses.
    """
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": params.temperature,
            "top_p": params.top_p,
            "num_ctx": params.num_ctx,
        },
    }
    if tools:
        body["tools"] = tools

    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise OllamaError(f"Chat request failed: {exc}") from exc

    if data.get("error"):
        raise OllamaError(data["error"])

    return data["message"]
