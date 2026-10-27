# The live duel room

The local room shows two teams building the same brief as events arrive. Open its capability URL in a browser, or use `--open` with `roundtable duel`. The room polls once per second and stays available after the duel until Ctrl-C (unless started with `--no-hold`). Replays use the same views without calling providers.

## Apps and Harness

Web duels open in **Apps**: Team A and Team B share the screen equally at widths of 960 pixels and up, and stack on smaller screens. Each pane shows the team's seats and provider/model chips, named stage segments, current status and a short note from the table. Segments distinguish building, done, failed and skipped stages. A finished team shows its completion time while the other keeps building.

The metrics strip shows tokens, cost, active time, versions, rewrites and errors. Errors combine failed turns, validation failures and page errors. Time excludes periods spent stopped. Unpriced tokens retain the **no price** label; priced spend covers only calls with known prices. Estimated token counts are marked.

A new build loads in a hidden sandboxed frame before replacing the visible frame. A brief version/stage badge marks the change. Choose a version to pin it; incoming builds then show a **new version** chip. **Live** returns to the latest valid build. Failed builds preserve the last valid app. The version buttons include stage names, with page-check status in their tooltips. **Current vs proposed** opens the previous and latest valid builds with a source diff. **Browser · checked screenshots** retains the latest checked or judged screenshot.

**Harness** shows each team's concept, critiques, stage transitions, build notes and connector tool notes in its own column. Judges' turns and verdicts, dissents and closing statements appear beneath the columns. The header switches between Apps and Harness; `#harness` in the URL preserves the choice without browser storage.

Code, diagram and text duels use Harness only. Their source appears in the team's column with file tabs. Source is displayed as inert text and is never executed.

## Stop, resume and choose

A live duel exposes only the commands currently available from its controller. **Stop** pauses the duel. The stopped banner reads “Stopped. Resume continues from where it stopped.” **Resume** continues the existing history and versions.

When a human judge is choosing, each team with a valid artifact offers **Approve Team A** or **Approve Team B**. Clicking it reveals **Confirm Team A wins** (or B), with Cancel available. A team without a valid artifact has a disabled button explaining why. The recorded choice highlights the winning pane and removes the approval buttons.

Replays, dry runs and rooms without a live controller show no action buttons. A replayed human choice is displayed as a recorded decision.

The end banner shows the winner, tie or lack of a verdict, followed by **Chosen by you** or **Judges' tally A 2 / B 0**. When metrics permit a comparison it shows the time and token differences. The chosen artifact's path is displayed relative to the Roundtable home (`ROUNDTABLE_HOME`).

## Terminal layouts

`--layout auto|split|stack` selects the terminal presentation. **auto** uses split on a TTY at least 100 columns wide, and stack otherwise. **split** uses equal team columns separated by `│`, with wrapped text and padding measured without ANSI colour codes. At widths below 100 columns it falls back to stack. **stack** interleaves team events with coloured `[A]` and `[B]` tags.

Stages and prototype summaries appear in their team's column. Completed stages print a two-team progress/time/token line. Judges, assessments, dissents, closing statements, control events, decisions and the result span the terminal. The end includes tokens, cost, time, versions, rewrites and errors for both teams, who decided and the chosen artifact path. `NO_COLOR` disables colour. NDJSON (`--json`) passes events through unchanged.

## Control route security

The room binds to loopback. Every route requires its random capability token and the shared server validates the Host header. `POST /control` is the only mutating route. The room page receives a separate random nonce per server start in a meta element; its external script sends the nonce in `X-Roundtable-Action`. The server compares digests in constant time. Neither token nor nonce is logged.

The route applies the same-origin checks used by the execution dashboard: an Origin header, when present, must name the room's own origin, and Sec-Fetch-Site, when present, must be `same-origin`. The custom header requires a CORS preflight across origins, which the server does not approve. A strict application/json body is limited to 1 KiB and accepts only stop, resume, or choose with team A/B. The controller validates availability again when receiving the command. Accepted commands return 202, unavailable commands 409, invalid bodies 400, and rooms without a controller 404. Origin and nonce failures return 403.

Prototype frames keep an opaque origin: their sandbox allows scripts, forms and modals, without same-origin access. Their `Origin: null` requests cannot control the room. POST requests to prototype routes remain refused. The room retains its strict CSP, external script and stylesheet, and inserts model text through `textContent`. Web artifacts keep the application CSP; other artifacts are served as inert text.

Screenshot placeholder: a 1280×720 Apps view showing one team finished while the other builds, followed by a Harness view. The promotional GIF will be added later.
