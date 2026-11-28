# Dev-server previews

A heads-down task, or a duel prototype, that builds a web app can be previewed. Its dev server runs in a locked-down Docker container and is published on `127.0.0.1` only. There is no tunnel, no `0.0.0.0` binding and no host networking. The dashboard task page, the duel room and the [`roundtable serve`](long-running.md) index show each preview using its recorded display mode.

```sh
roundtable preview start exe-… my-task            # a task's worktree
roundtable preview start --prototype <dir>        # a prototype directory (a duel team's version, a losing team's too)
roundtable preview start --prototype <dir> --display screenshot
roundtable preview list [--json]
roundtable preview stop prv-…
```

The same operations are the orchestrator tools `start_preview`, `list_previews` and `stop_preview` ([tools](tools.md#previews)).

## Display modes

| Mode | Display and trade-off |
| --- | --- |
| `live` | Automatically loads a sandboxed iframe. The app is interactive as soon as the page displays it. |
| `click` | Shows a card with the label, origin and **Load preview** button. Creates the iframe only after that click, so you choose when the app becomes interactive. The choice lasts for the current page session; reloading returns to the card. |
| `screenshot` | Shows the latest page-check screenshot when available, plus **Open in a new tab**. It never creates an iframe. The image captures the checked page at that time; open the link to interact with the app. When page checks are disabled or no screenshot is available, the card still shows the link. |

Set `--display live|click|screenshot` on the CLI or `display` on `start_preview`. Precedence is the explicit option, then a valid `ROUNDTABLE_PREVIEW_DISPLAY` value, then the starter default. The CLI defaults to `live` when you start it from an interactive terminal (stdin and stdout are both terminals), including when previewing a task's worktree; click otherwise. MCP tools and programmatic starts, including execution runs, default to `click`. A CLI invoked by a heads-down or runtime worker has no terminal, and one carrying `ROUNDTABLE_EXECUTION_ID` or `ROUNDTABLE_AGENT_ID` is treated the same, so both default to `click`. Invalid explicit modes are refused; an invalid environment default is reported and ignored. The chosen mode is saved on the preview record and returned in lists and the room's `/previews.json`. Existing records without a mode retain `live` behaviour.

The display mode controls when the person's browser loads the app in a frame. The dev server, readiness check and headless page check run in all three modes. A live or loaded click preview executes the app's JavaScript in the browser; screenshot mode displays a captured image. New-tab links use `target="_blank"` and `rel="noopener noreferrer"`.

## What runs

- The command is always `npm run <script>`, where `<script>` is `dev`, `start` or `preview`: the one you pass with `--script`, otherwise the first the package defines. Anything else is refused; a free-form command is never run.
- The container port is `--port`, otherwise the usual port of the dev server the package depends on (Vite 5173, Astro 4321, Parcel 1234, Angular 4200, Next and Create React App 3000), otherwise 3000. The server must listen on all interfaces inside the container; the container sets `HOST=0.0.0.0`, `HOSTNAME=0.0.0.0` and `PORT=<port>`, which most dev servers honour. A Vite script needs `--host` to listen on all interfaces: when the script is one plain `vite` command without `--host`, the preview runs `npm run <script> -- --host 0.0.0.0` (that fixed pair is the only argument ever passed through). When a Vite script is more complex (`vite && …`, `cross-env … vite`) and has no `--host`, the start is refused before anything runs, with a message to add `--host` to the script (for example `"dev": "vite --host"`). A script that already has `--host` is run as is.
- A preview is ready when the published port answers HTTP (default timeout 120 seconds). Then the [page check](modes/prototype-mode.md) loads it in headless Chrome, unless page checks are off (`ROUNDTABLE_PAGE_CHECKS=0`) or there is no browser. The result is recorded as page-check metadata, with the captured PNG stored separately for display; a failed check does not stop the preview. While it runs, the browser can reach only the preview's own address.

## What is isolated

- The container has a read-only root, every capability dropped, `no-new-privileges`, pid, memory and CPU limits (the `ROUNDTABLE_SANDBOX_*` ones), a non-root user and no container log. It is the same set of flags the command sandbox uses.
- **The host source is never mounted.** The source is copied in as a tar snapshot on the container's stdin and unpacked into a tmpfs at `/app`, so the server and anything it installs can write only inside the container. The snapshot leaves out `.git`, `.env*`, `.npmrc` and `.netrc` (and a host `node_modules` that is empty or missing). It is capped at 256 MB. Writes inside the container are lost when it stops; the task's worktree is unchanged.
- **No network from the dev server.** Each preview gets its own `--internal` Docker network that the server alone sits on, so it has no route out. Docker cannot publish a port from an internal network, so a small forwarder container (fixed code, same hardening, 128 MB) joins that network and a network of its own (`rt-pvfwd-…`, one per preview, labelled like the internal one and removed with it) and carries the single published port, `-p 127.0.0.1::<port>`. Docker picks the host port and `roundtable` reads it back with `docker port`.
- **Dependencies.** If the source already has a `node_modules` directory it is used as is. Otherwise `npm ci` (with a lockfile) or `npm install` runs in a container first, with lifecycle scripts off (`--ignore-scripts`) and the npm registry as the only reachable host, through the same egress proxy as contract install steps. The installed tree (capped at 1 GB) is then carried into the server container, which has no network.
- Containers carry the labels `roundtable.preview=<id>` (plus `roundtable.preview-execution`, `-task`, `-prototype` or `-duel`). A prototype directory must be inside the prototype root (`ROUNDTABLE_PROTOTYPE_DIR`) and not a symlink.

## Embedding

The dashboard's task page (`/tasks/<id>`), the duel room and the serve index use `<iframe sandbox="allow-scripts allow-forms">` for `live` and loaded `click` previews. There is no `allow-same-origin`, so a previewed page cannot read the embedding page, its URL capability or its storage. Each page adds `frame-src` entries for its `live` and `click` previews' `http://127.0.0.1:<port>` origins; `screenshot` previews are excluded. The rest of the strict Content-Security-Policy stays in place, with external scripts and event listeners. Text about a preview is redacted and escaped or inserted with `textContent`. Screenshots are served through the embedding page's capability URL, scoped to its previews.

A preview of a duel's prototype carries the duel's id, and the room shows only the previews of that duel. The room's page policy is fixed when it loads: reload the room after starting a `live` or `click` preview. Screenshot cards can appear on the next poll. The serve index stops its 15-second refresh while a preview iframe is on the page, including one loaded by a click, so the app is not restarted.

A preview is also an ordinary local address: opening `http://127.0.0.1:<port>/` in your own browser works, from this machine only.

## Lifecycle and limits

| Rule | Value |
| --- | --- |
| Idle TTL | 30 minutes (`ROUNDTABLE_PREVIEW_TTL_MIN`). Starting, `preview list`, `list_previews` and opening the task page count as use. The room and the index do not, since they refresh on their own. |
| Concurrent previews | 3 (`ROUNDTABLE_PREVIEW_MAX`); a fourth start is refused until one is stopped. |
| Readiness timeout | 120 seconds (`ROUNDTABLE_PREVIEW_READY_TIMEOUT_SEC`). |
| Stop | `preview stop <id>`, when the run ends (the runner stops that run's previews as it shuts down, best effort and bounded; the sweep is the backstop), and when `roundtable serve` stops (all previews). |
| Sweep | At every start, list and once a minute in `serve`: removes expired previews, previews whose run ended, records whose container is gone, and labelled containers (and networks) of this host that have no record. |

If Docker is not running, `preview start` says so and starts nothing; the sweep waits for the daemon. State is one private file per preview in `ROUNDTABLE_HOME/previews/<id>.json`, with a page-check screenshot at `<id>.png` when available. Stopping the preview removes both files. Screenshots are kept out of event logs and archives.
