import { invoke } from "@tauri-apps/api/core";

interface Card {
  text: string;
  checked: boolean;
  tags: string[];
}

interface Lane {
  name: string;
  cards: Card[];
}

interface Board {
  lanes: Lane[];
}

function renderBoard(board: Board): string {
  return board.lanes
    .map((lane) => {
      const cards = lane.cards
        .map((card) => {
          const box = card.checked ? "[x]" : "[ ]";
          return `<li>${box} ${escapeHtml(card.text)}</li>`;
        })
        .join("");
      return `<section><h2>${escapeHtml(lane.name)} (${lane.cards.length})</h2><ul>${cards}</ul></section>`;
    })
    .join("");
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

window.addEventListener("DOMContentLoaded", async () => {
  const boardEl = document.querySelector<HTMLElement>("#board");
  if (!boardEl) return;
  try {
    const board = await invoke<Board>("read_kanban_board");
    boardEl.innerHTML = renderBoard(board);
  } catch (err) {
    boardEl.textContent = `Failed to load board: ${err}`;
  }
});
