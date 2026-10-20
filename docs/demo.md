# Record a duel

Prepare six generic personas in the configured agents directory: `designer`, `builder`, `marketer`, `skeptic`, `cfo`, and `safety-reviewer`. Use the configured credential source and provider keys. Keep credentials, configuration paths, and real archives out of the recording.

Check the room layout without spending tokens:

```sh
npm run build
roundtable duel --replay test/fixtures/duel/demo.json --speed 2 --open
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
