// Parses the actual live docs/Kanban.md (not synthetic fixtures) to prove
// the parser handles real content, not just the happy-path test cases.

use kanban_reader_lib::kanban;

fn real_board_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("docs")
        .join("Kanban.md")
}

#[test]
fn parses_the_real_kanban_file() {
    let path = real_board_path();
    let contents = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));

    let board = kanban::parse(&contents);

    assert!(
        !board.lanes.is_empty(),
        "expected at least one lane, got none"
    );

    let total_cards: usize = board.lanes.iter().map(|l| l.cards.len()).sum();
    assert!(total_cards > 0, "expected at least one card, got none");

    let done_lane = board
        .lanes
        .iter()
        .find(|l| l.name == "Done")
        .unwrap_or_else(|| panic!("expected a 'Done' lane in the real board"));
    assert!(
        done_lane
            .cards
            .iter()
            .any(|c| c.text.contains("Scaffold React")),
        "expected the known 'Scaffold React...' card in Done"
    );

    println!(
        "parsed {} lanes, {} total cards from {}",
        board.lanes.len(),
        total_cards,
        path.display()
    );
    for lane in &board.lanes {
        println!("  [{}] {} cards", lane.name, lane.cards.len());
    }
}
