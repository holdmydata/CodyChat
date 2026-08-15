"""One-shot proof: model-directed tool dispatch, gated behind confirmation.

Usage:
    python run_tool_demo.py "<prompt>" [--auto-confirm]

--auto-confirm bypasses the interactive y/n gate for non-interactive proof
runs (this session's sandboxed shell has no real stdin for input() to read
from). It still prints exactly what it's approving and logs plainly that
no human actually approved it, rather than silently skipping the gate.
"""

from __future__ import annotations

import argparse

import ollama
import skills

MODEL = "qwen3.5:9b"  # tool-calling-capable small model; the 27B stays the main model


def make_confirm(auto: bool):
    def confirm(name: str, arguments: dict) -> bool:
        print(f"\n>>> Model wants to run skill: {name}({arguments})")
        if auto:
            print(">>> AUTO-CONFIRMED (non-interactive mode, no real human approval)")
            return True
        answer = input(">>> Allow? [y/N] ").strip().lower()
        return answer == "y"

    return confirm


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--auto-confirm", action="store_true")
    args = parser.parse_args()

    messages: list[dict] = [{"role": "user", "content": args.prompt}]
    confirm = make_confirm(args.auto_confirm)

    message = ollama.chat(MODEL, messages, tools=skills.TOOL_DEFINITIONS)
    tool_calls = message.get("tool_calls") or []

    if not tool_calls:
        print(message.get("content", ""))
        return

    messages.append(message)
    for call in tool_calls:
        name = call["function"]["name"]
        arguments = call["function"]["arguments"]
        try:
            result = skills.dispatch(name, arguments, confirm)
        except skills.SkillError as exc:
            result = f"error: {exc}"
        print(f">>> Skill result: {result[:200]!r}")
        messages.append({"role": "tool", "content": result})

    final = ollama.chat(MODEL, messages, tools=skills.TOOL_DEFINITIONS)
    print("\n--- Final response ---")
    print(final.get("content", ""))


if __name__ == "__main__":
    main()
