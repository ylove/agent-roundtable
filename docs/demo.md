# Record a duel

A script for screen-recording a [duel](modes/duel.md) from the [terminal](table-cli.md). It uses only generic personas.

Prepare six generic personas in the configured agents directory: `designer`, `builder`, `marketer`, `skeptic`, `cfo`, and `safety-reviewer`. Use the configured credential source and provider keys. Keep credentials, configuration paths, and real archives out of the recording.

Check the room layout without spending tokens:

```sh
npm run build
roundtable duel --replay examples/duel/demo.json --speed 2 --open
```

This synthetic fixture contains two tiny playable games, judges' verdicts, a dissent, and example usage. Try both games, show the seat cards, then show the winner and dissent. Press Ctrl-C to close the room.

Before the live take, check the selected seats:

```sh
roundtable duel "60-second browser game that teaches kids to budget" \
  --team-a designer,builder --team-b marketer,skeptic \
  --judges cfo,safety-reviewer --mix auto --preflight
```

Start the recording with the terminal and browser side by side. Run:

```sh
roundtable duel "60-second browser game that teaches kids to budget" \
  --team-a designer,builder --team-b marketer,skeptic \
  --judges cfo,safety-reviewer --mix auto --open
```

Narration and camera cues:

1. Show the topic and two teams taking seats at the table. Point out the provider and model labels.
2. As concepts arrive, describe the different budget lessons. Builders then go heads-down.
3. When both games appear, play each for a few choices. Keep both games visible side by side.
4. Show each judge's verdict chips and reasons. Point out any disagreement.
5. End on the winner or tie banner, dissent cards, and spend footer. Let the room stay visible after the terminal finishes.

Reasoning models such as GLM are slow builders: their thinking tokens count against the output limit, so builds can time out or run out of tokens. For a recording, pin the builders to fast non-reasoning models with `--seat`, for example `--seat builder=anthropic:sonnet,skeptic=openai`. Duel output ceilings are also capped per provider (Replicate and Together 16384, Ollama 8192), because some models reject larger limits.

Allow roughly three to five minutes for a typical run; actual duration depends on provider responses and retries. Add `--rounds 2` for one revision round, or `--max-seconds 240` to move to closing statements sooner. Do not promise a winner: a tie stays a tie. If a prototype fails twice, show its placeholder and the automatic rejection.

For a repeatable second take, replay the resulting archive from local state with `--replay`. Keep real persona archives in `ROUNDTABLE_HOME`; only the synthetic fixture belongs in the repository.

Offline verification for this slice:

```sh
npm run build
node --import ./test/fixtures/foundation/test-env.mjs --test test/unit/duel.test.mjs test/unit/replay.test.mjs
```

On a machine that allows loopback listeners, also run:

```sh
node --import ./test/fixtures/foundation/test-env.mjs --test test/unit/room.test.mjs
```

## Recording the duel GIF

`docs/assets/live-duel.gif` (the README animation) is recorded from the bundled synthetic duel, so it needs no keys and anyone can reproduce it. The two teams build different apps for the same brief, a coin game and a pocket planner, from grey skeletons to polished pages, and the room ends on the winner banner.

```sh
npm run build
node scripts/record-duel.mjs ./media --speed 3
```

The dev script (it is not shipped in the package) runs `duel --dry-run` with the room open, a fresh temporary `ROUNDTABLE_HOME` and the given `--speed`. It captures the room in headless Chrome at 1280×720 with a device scale factor of 2 (frames every 100 ms, until about three seconds after the winner banner), then encodes with ffmpeg. It needs Chrome (`ROUNDTABLE_CHROME_PATH` to override) and ffmpeg (`FFMPEG` to override), and it stops every process it starts, even on error.

Outputs: the GIF at `docs/assets/live-duel.gif` (or `--gif <path>`; about 960 px wide, 12 fps, under 8 MB), and `live-duel-1280.mp4` and `live-duel-1080.mp4` (H.264, 30 fps, `+faststart`) in the output directory, for social posts. Pass `--keep-frames` to keep the captured frames for inspection. The fixture is `examples/duel/demo.json`; the room's preview scaling lives in `src/table/room-assets.ts`.
