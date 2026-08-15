//! Parses an Obsidian Kanban-plugin markdown file (frontmatter + `## Lane`
//! headers + `- [ ]` / `- [x]` checklist cards) into structured data.

use serde::Serialize;

#[derive(Serialize)]
pub struct Card {
    pub text: String,
    pub checked: bool,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
pub struct Lane {
    pub name: String,
    pub cards: Vec<Card>,
}

#[derive(Serialize)]
pub struct Board {
    pub lanes: Vec<Lane>,
}

pub fn parse(markdown: &str) -> Board {
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

        // The `%% kanban:settings ... %%` block at the end is plugin
        // bookkeeping, not board content — stop parsing once we hit it.
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
    let text = rest.trim().to_string();
    let tags = extract_tags(&text);
    Some(Card {
        text,
        checked,
        tags,
    })
}

fn extract_tags(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(|token| token.strip_prefix('#'))
        .map(|tag| tag.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_'))
        .filter(|tag| !tag.is_empty())
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lanes_and_cards() {
        let md = "---\nkanban-plugin: board\n---\n\n## Done\n\n- [x] Finished thing #phase0\n\n## Ready\n\n- [ ] Next thing #phase1 #harness\n\n%% kanban:settings\n```\n{}\n```\n%%\n";
        let board = parse(md);
        assert_eq!(board.lanes.len(), 2);
        assert_eq!(board.lanes[0].name, "Done");
        assert_eq!(board.lanes[0].cards.len(), 1);
        assert!(board.lanes[0].cards[0].checked);
        assert_eq!(board.lanes[0].cards[0].tags, vec!["phase0"]);
        assert_eq!(board.lanes[1].name, "Ready");
        assert!(!board.lanes[1].cards[0].checked);
        assert_eq!(board.lanes[1].cards[0].tags, vec!["phase1", "harness"]);
    }

    #[test]
    fn ignores_non_card_lines() {
        let md = "## Lane\n\nSome prose, not a card.\n\n- [ ] Real card\n";
        let board = parse(md);
        assert_eq!(board.lanes[0].cards.len(), 1);
        assert_eq!(board.lanes[0].cards[0].text, "Real card");
    }
}
