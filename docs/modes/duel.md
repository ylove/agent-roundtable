# Duel

A duel puts two teams at the table to build small browser games. The terminal shows their turns; the local room keeps both games playable alongside verdicts, seat models and spend, dissents, and the winner or tie.

```sh
roundtable duel "60-second browser game that teaches kids to budget" \
  --team-a designer,builder --team-b marketer,skeptic \
  --judges cfo,safety-reviewer --mix auto --open
```

Use personas available in your agents directory. The first seat on each team designs the concept; the last seat builds the game. Judges assess both sources independently. Per-seat provider and model selection belongs to the CLI's seat resolver.

The rounds are:

1. R1: both designers propose a concept of at most 150 words, in parallel.
2. R1b: both builders submit one `index.html`, with inline CSS and JavaScript, no external URLs, and at most 40 KB of UTF-8. A full game should take at most 60 seconds. Invalid submissions get one retry with the validation error.
3. R2: judges see both sources and write `VERDICT A: APPROVE — reason` and an equivalent line for B. APPROVE adds one point, REVISE adds zero, and REJECT subtracts one. Missing or ambiguous responses are UNCLEAR and add zero. A failed judge casts no verdict. Teams without valid games receive automatic REJECTs.
4. With `--rounds 2`, R3 gives each team receiving REVISE or REJECT one revision, with the same validation retry. The original judging tally determines the result; revisions remain available to play. A failed revision preserves an earlier valid game.
5. R4: designers give closing statements; the losing team is asked to file a dissent. Complete `<DISSENT>` blocks become separate cards. Equal scores stay a tie.

Concept, judging and closing calls time out after 90 seconds (set with `--turn-timeout`); build calls get at least 240 seconds. The `--max-seconds` deadline defaults to 600 seconds. It cancels pending work and skips ahead to closing statements; closing calls have their own turn timeout. Ctrl-C cancellation ends provider work and archives the partial result. The room remains available after the end until Ctrl-C; `--no-hold` lets automation finish without waiting.

Archives live at `ROUNDTABLE_HOME/duels/<id>.json` with mode 0600. They contain the event list and the prototype files as text, including revisions. The duel owns its sandbox until process exit; games survive judging and have no TTL. Real archives belong in local state and must stay out of the repository.

Usage updates include per-seat token totals and estimated spend throughout the run. Estimates use the existing pricing table; models without rates contribute zero to the displayed total. Configure `ROUNDTABLE_PRICING_FILE` to provide rates for those models before recording a cost comparison.

```sh
roundtable duel --replay examples/duel/demo.json --speed 2 --open
roundtable duel --dry-run --no-hold --json
```

Replay re-emits recorded events and prototype contents through the same observers, with no provider calls or keys. The repository fixture is synthetic and uses generic personas. `--speed` scales the intervals between recorded timestamps.

The room binds to loopback and requires a capability token. Its page uses an external script under a strict CSP. Prototype routes serve only recorded files from memory, with the existing application CSP. Game frames allow scripts, forms, and modals with an opaque origin. The room writes model text into the DOM with `textContent`.

For integration, `runDuel(opts, observer, signal, { resolveSeats })` accepts a resolver returning seats with optional persona `prompt` text. The three-argument call uses `resolveSeatsLocal`. `startRoom({ open, hold })` returns an observer, URL, and asynchronous `close()`. Pass its observer directly or through `fanout` so prototype content attachments reach the room; NDJSON remains the shared event shape. `replayDuel(path, observer, { speed, signal })` uses the same attachment mechanism. Event streams received from another process can supply bytes with the room's `setPrototypeFiles(team, files)` method before the corresponding prototype event.
