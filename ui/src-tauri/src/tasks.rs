//! Per-project task tracking backed by a plain Obsidian Kanban-plugin
//! markdown file (`AGENT_TASKS.md` at each project's own root) — replaces
//! the former loopx/WSL-backed digest + autonomous-loop todo source (see
//! local-docs/MEMORY.md's 2026-08-22 entry for the full reasoning). loopx's
//! own actually-used surface here was always small (~5 read fields, 3 write
//! ops), but *driving* it — from this app's autonomous loop, or from an
//! agent doing this project's own dev work — meant reasoning about a WSL
//! shell-out and loopx's own CLI/JSON contract every single time, real
//! recurring overhead that outweighed what its governance features
//! (quota/spend-slot, multi-agent coordination) actually bought a solo
//! local app that never used them. A markdown file with two lanes needs
//! none of that: "next task" is the first unchecked `- [ ]` under
//! `## Ready`, "complete" is flipping it to `- [x]` and moving it under
//! `## Done` with evidence appended — plain file I/O, no subprocess, and
//! still openable/editable in Obsidian like every other kanban board in
//! this repo.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub(crate) struct TrackedProject {
    pub(crate) id: &'static str,
    pub(crate) project_dir: &'static str,
}

// pub(crate) so a future sibling module could extend this the way loopx.rs
// once did — every command below resolves a project_dir from this same
// list, keyed by id, so an unknown id fails loudly instead of reading or
// writing an arbitrary path the frontend happened to send.
pub(crate) const TRACKED_PROJECTS: &[TrackedProject] = &[
    TrackedProject {
        id: "meansquares-shell",
        project_dir: r"d:\MeanSquares\CodyChat\ui",
    },
    TrackedProject {
        id: "kanban-reader",
        project_dir: r"d:\MeanSquares\CodyChat\toys\kanban-reader",
    },
    TrackedProject {
        id: "threejs-game",
        project_dir: r"d:\MeanSquares\CodyChat\toys\threejs-game",
    },
    TrackedProject {
        id: "cffb",
        project_dir: r"d:\MeanSquares\CodyChat\toys\cffb",
    },
];

const TASKS_FILENAME: &str = "AGENT_TASKS.md";
const READY_LANE: &str = "Ready";
const DONE_LANE: &str = "Done";

fn resolve_project(id: &str) -> Result<&'static str, String> {
    TRACKED_PROJECTS
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.project_dir)
        .ok_or_else(|| format!("unknown project id: {id}"))
}

fn tasks_path(project_dir: &str) -> PathBuf {
    Path::new(project_dir).join(TASKS_FILENAME)
}

#[derive(Clone, PartialEq, Debug)]
struct Card {
    text: String,
    checked: bool,
}

#[derive(Clone, PartialEq, Debug)]
struct Lane {
    name: String,
    cards: Vec<Card>,
}

#[derive(PartialEq, Debug)]
struct Board {
    lanes: Vec<Lane>,
}

// Deliberately just two lanes (Ready/Done) and plain checkbox cards, no tag
// extraction — this format only ever needs to answer "what's next" and
// "mark this one done", unlike local-docs/Kanban.md's much richer
// human-planning board. Same parse shape as
// toys/kanban-reader/src-tauri/src/kanban.rs (frontmatter, `## Lane`
// headers, `- [ ]`/`- [x]` cards, stop at `%% kanban:settings %%`) so the
// file stays genuinely Obsidian-Kanban-plugin compatible — kept as its own
// small copy rather than a shared crate between two otherwise-independent
// Tauri apps, matching this project's established pattern of small
// duplication over a build-time dependency (loopx_client.py/ollama.py/
// kanban.rs/mcp.rs were all the same call).
fn parse(markdown: &str) -> Board {
    let mut lanes: Vec<Lane> = Vec::new();
    let mut current: Option<Lane> = None;
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    let mut past_settings = false;

    for (i, line) in markdown.lines().enumerate() {
        let trimmed = line.trim();

        if !frontmatter_done && i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                frontmatter_done = true;
            }
            continue;
        }
        if trimmed.starts_with("%%") {
            past_settings = true;
        }
        if past_settings {
            continue;
        }
        if let Some(name) = trimmed.strip_prefix("## ") {
            if let Some(lane) = current.take() {
                lanes.push(lane);
            }
            current = Some(Lane {
                name: name.trim().to_string(),
                cards: Vec::new(),
            });
            continue;
        }
        if let Some(card) = parse_card_line(trimmed) {
            if let Some(lane) = current.as_mut() {
                lane.cards.push(card);
            }
        }
    }
    if let Some(lane) = current.take() {
        lanes.push(lane);
    }
    Board { lanes }
}

fn parse_card_line(line: &str) -> Option<Card> {
    let rest = line.strip_prefix("- [")?;
    let (mark, rest) = rest.split_at(1);
    let rest = rest.strip_prefix("] ")?;
    let checked = mark.eq_ignore_ascii_case("x");
    if !checked && mark != " " {
        return None;
    }
    Some(Card {
        text: rest.trim().to_string(),
        checked,
    })
}

fn lane<'a>(board: &'a Board, name: &str) -> Option<&'a Lane> {
    board.lanes.iter().find(|l| l.name.eq_ignore_ascii_case(name))
}

fn render(board: &Board) -> String {
    let mut out = String::from("---\n\nkanban-plugin: board\n\n---\n\n");
    for lane in &board.lanes {
        out.push_str(&format!("## {}\n\n", lane.name));
        for card in &lane.cards {
            let mark = if card.checked { "x" } else { " " };
            out.push_str(&format!("- [{mark}] {}\n", card.text));
        }
        out.push('\n');
    }
    out.push_str("%% kanban:settings\n```\n{}\n```\n%%\n");
    out
}

fn read_board(project_dir: &str) -> Result<Board, String> {
    let path = tasks_path(project_dir);
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(parse(&text))
}

#[derive(Serialize, Clone)]
pub struct NextTask {
    text: String,
}

#[derive(Serialize, Clone)]
pub struct TaskDigest {
    project_id: String,
    should_run: bool,
    task_total: u64,
    task_open: u64,
    task_done: u64,
    next_task: Option<NextTask>,
    error: Option<String>,
    // Surfaced so an autonomous turn can be told which real project a given
    // task is actually about — see useAutonomousLoop.ts's buildTaskPrompt.
    project_dir: String,
}

fn empty_digest(project: &TrackedProject, error: String) -> TaskDigest {
    TaskDigest {
        project_id: project.id.to_string(),
        should_run: false,
        task_total: 0,
        task_open: 0,
        task_done: 0,
        next_task: None,
        error: Some(error),
        project_dir: project.project_dir.to_string(),
    }
}

fn digest_one(project: &TrackedProject) -> TaskDigest {
    let board = match read_board(project.project_dir) {
        Ok(b) => b,
        Err(e) => return empty_digest(project, e),
    };
    let ready_cards = lane(&board, READY_LANE).map(|l| l.cards.as_slice()).unwrap_or(&[]);
    let done_count = lane(&board, DONE_LANE).map(|l| l.cards.len()).unwrap_or(0) as u64;
    let open: Vec<&Card> = ready_cards.iter().filter(|c| !c.checked).collect();
    TaskDigest {
        project_id: project.id.to_string(),
        should_run: !open.is_empty(),
        task_total: open.len() as u64 + done_count,
        task_open: open.len() as u64,
        task_done: done_count,
        next_task: open.first().map(|c| NextTask { text: c.text.clone() }),
        error: None,
        project_dir: project.project_dir.to_string(),
    }
}

// Plain file reads, one per tracked project — no subprocess, no round-trip
// latency worth threading (unlike the old WSL-backed version), so this
// stays simple synchronous work instead of the thread-per-goal fan-out
// get_loopx_digest needed to hide subprocess latency.
#[tauri::command]
pub fn get_task_digest() -> Vec<TaskDigest> {
    TRACKED_PROJECTS.iter().map(digest_one).collect()
}

#[derive(Serialize, Clone)]
pub struct TaskItem {
    text: String,
    status: String,
}

// Every card across both lanes (not just Ready) — backs the "Show all
// tasks" toggle, same on-demand-only shape the old loopx_todo_list had
// (kept out of get_task_digest's own per-project read so opening it can't
// make the digest itself feel slower, even though a local file read is
// cheap enough that this distinction matters far less than it did against
// a WSL round-trip).
#[tauri::command(rename_all = "snake_case")]
pub fn list_tasks(project_id: String) -> Result<Vec<TaskItem>, String> {
    let project_dir = resolve_project(&project_id)?;
    let board = read_board(project_dir)?;
    let mut items = Vec::new();
    if let Some(l) = lane(&board, READY_LANE) {
        items.extend(l.cards.iter().map(|c| TaskItem {
            text: c.text.clone(),
            status: if c.checked { "done" } else { "open" }.to_string(),
        }));
    }
    if let Some(l) = lane(&board, DONE_LANE) {
        items.extend(l.cards.iter().map(|c| TaskItem {
            text: c.text.clone(),
            status: "done".to_string(),
        }));
    }
    Ok(items)
}

// Moves the exact-matching open Ready card to Done, checked, with evidence
// appended after an em dash. Exact-text match (not fuzzy) is deliberate:
// the caller (useAutonomousLoop.ts) always passes back the identical text
// it just read from the digest's next_task, so a match failure means the
// file changed out from under the run (e.g. a person editing it
// concurrently) rather than a normal case worth papering over silently.
fn apply_complete(board: &mut Board, task_text: &str, evidence: &str) -> Result<(), String> {
    let ready_idx = board
        .lanes
        .iter()
        .position(|l| l.name.eq_ignore_ascii_case(READY_LANE))
        .ok_or_else(|| format!("no \"{READY_LANE}\" lane"))?;
    let card_idx = board.lanes[ready_idx]
        .cards
        .iter()
        .position(|c| !c.checked && c.text == task_text)
        .ok_or_else(|| format!("task not found in {READY_LANE} (file may have changed): {task_text}"))?;
    let mut card = board.lanes[ready_idx].cards.remove(card_idx);
    card.checked = true;
    card.text = format!("{} — {evidence}", card.text);

    if let Some(done) = board.lanes.iter_mut().find(|l| l.name.eq_ignore_ascii_case(DONE_LANE)) {
        done.cards.push(card);
    } else {
        board.lanes.push(Lane {
            name: DONE_LANE.to_string(),
            cards: vec![card],
        });
    }
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn complete_task(project_id: String, task_text: String, evidence: String) -> Result<(), String> {
    let project_dir = resolve_project(&project_id)?;
    let path = tasks_path(project_dir);
    let mut board = read_board(project_dir)?;
    apply_complete(&mut board, &task_text, &evidence)?;
    fs::write(&path, render(&board)).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] First task\n- [ ] Second task\n\n## Done\n\n- [x] Old done task\n\n%% kanban:settings\n```\n{}\n```\n%%\n";

    #[test]
    fn parses_lanes_and_cards() {
        let board = parse(SAMPLE);
        assert_eq!(board.lanes.len(), 2);
        assert_eq!(board.lanes[0].name, "Ready");
        assert_eq!(board.lanes[0].cards.len(), 2);
        assert!(!board.lanes[0].cards[0].checked);
        assert_eq!(board.lanes[1].cards[0].text, "Old done task");
        assert!(board.lanes[1].cards[0].checked);
    }

    #[test]
    fn ignores_non_card_lines() {
        let md = "## Lane\n\nSome prose, not a card.\n\n- [ ] Real card\n";
        let board = parse(md);
        assert_eq!(board.lanes[0].cards.len(), 1);
        assert_eq!(board.lanes[0].cards[0].text, "Real card");
    }

    #[test]
    fn digest_reports_first_open_ready_card_and_counts() {
        let board = parse(SAMPLE);
        let ready_cards = lane(&board, READY_LANE).unwrap().cards.as_slice();
        let done_count = lane(&board, DONE_LANE).unwrap().cards.len();
        let open: Vec<&Card> = ready_cards.iter().filter(|c| !c.checked).collect();
        assert_eq!(open.len(), 2);
        assert_eq!(open[0].text, "First task");
        assert_eq!(done_count, 1);
    }

    #[test]
    fn apply_complete_moves_card_to_done_with_evidence_appended() {
        let mut board = parse(SAMPLE);
        apply_complete(&mut board, "First task", "did it").unwrap();

        let ready = lane(&board, READY_LANE).unwrap();
        assert_eq!(ready.cards.len(), 1);
        assert_eq!(ready.cards[0].text, "Second task");

        let done = lane(&board, DONE_LANE).unwrap();
        assert_eq!(done.cards.len(), 2);
        assert_eq!(done.cards[1].text, "First task — did it");
        assert!(done.cards[1].checked);
    }

    #[test]
    fn apply_complete_errors_when_text_does_not_match_an_open_card() {
        let mut board = parse(SAMPLE);
        assert!(apply_complete(&mut board, "Not a real task", "evidence").is_err());
        // An already-checked card can't be completed again.
        assert!(apply_complete(&mut board, "Old done task", "evidence").is_err());
    }

    #[test]
    fn apply_complete_creates_done_lane_when_missing() {
        let mut board = parse("---\n\nkanban-plugin: board\n\n---\n\n## Ready\n\n- [ ] Only task\n");
        apply_complete(&mut board, "Only task", "evidence").unwrap();
        assert_eq!(lane(&board, DONE_LANE).unwrap().cards.len(), 1);
    }

    #[test]
    fn render_round_trips_through_parse() {
        let board = parse(SAMPLE);
        let rendered = render(&board);
        let reparsed = parse(&rendered);
        assert_eq!(reparsed, board);
    }

    #[test]
    fn resolve_project_errors_on_unknown_id() {
        assert!(resolve_project("not-a-real-project").is_err());
    }

    #[test]
    fn resolve_project_finds_known_project() {
        let dir = resolve_project("cffb").unwrap();
        assert!(dir.ends_with("cffb"));
    }
}
