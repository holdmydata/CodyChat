"""Skill registry + dispatch for model-directed tool-calling.

The harness passes TOOL_DEFINITIONS to Ollama's `tools` parameter; when the
model requests a call, dispatch() looks it up in SKILLS and requires
explicit confirmation before running it — nothing executes just because
the model asked.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

MAX_READ_BYTES = 200_000


class SkillError(Exception):
    pass


def read_file(path: str) -> str:
    p = Path(path)
    if not p.is_file():
        raise SkillError(f"not a file: {path}")
    data = p.read_bytes()[:MAX_READ_BYTES]
    return data.decode("utf-8", errors="replace")


SKILLS: dict[str, Callable[..., str]] = {
    "read_file": read_file,
}

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a text file from disk.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to read",
                    },
                },
                "required": ["path"],
            },
        },
    },
]


def dispatch(name: str, arguments: dict, confirm: Callable[[str, dict], bool]) -> str:
    """Runs a skill by name, but only after `confirm` approves it.

    `confirm` is injected rather than hardcoded to a CLI prompt so callers
    (interactive CLI now, an eventual shell-driven confirmation later) can
    supply their own gate without changing dispatch logic.
    """
    if name not in SKILLS:
        raise SkillError(f"unknown skill: {name}")
    if not confirm(name, arguments):
        return f"User declined to run skill '{name}'."
    return SKILLS[name](**arguments)
