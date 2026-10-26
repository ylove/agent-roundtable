# Long-running runs and private check-ins

Start a heads-down run from your chat, then run:

```sh
roundtable serve
# Or let it outlive this terminal:
roundtable serve --detach
roundtable serve status
roundtable serve stop
```

One local process per `ROUNDTABLE_HOME` keeps watch after the chat closes. Its private index lists executions, completion, spending, human decisions, runner health, last event times, live and archived duels, and the latest casting report. Execution overview and escalation pages reuse the dashboard. Every index route is read-only. Pages refresh every 15 seconds.

The URL contains a capability token. `serve` and `serve status` display it only when stdout is a terminal. Open it yourself; do not paste it into logs or public channels. Detached output goes to `ROUNDTABLE_HOME/serve/serve.log` (0600). `serve.json` stores process identity and the URL privately (0600); a clean stop removes it. The service uses the same dead-process lock recovery as executions and refuses another host's lock. `stop` signals only a process whose host and start identity match the service lock.

## Keeping runners alive

At startup and every 15 seconds, the supervisor checks each active execution. A dead local runner is restarted through `ensureRunner`. A live pid is protected even with a stale heartbeat. Remote runners, paused runs and terminal runs are left alone. A recorded clean stop is restarted only after its local pid is confirmed dead; a run with no known runner is left alone. Use `--no-keep-runners` for an index and check-ins without automatic restarts.

After failed attempts the delays are 15 seconds, one minute, then five minutes. There are at most six relaunch attempts per rolling hour, recorded across service restarts. Hitting the cap queues one “runner keeps dying” check-in; attempts resume as old entries age out. Check the execution's runner log and run `roundtable status <tag>` for details. A six-character tag must identify exactly one execution; use its full id if tags collide.

## Private check-in channels

These channels are separate from public session publishing. Zero channels is valid: the service reports “no check-in channel configured” once and continues. Restart `serve` after changing configuration. `roundtable config show` lists configured channel names without credential values.

All saved credentials, including an ntfy username, must be `secret://env/NAME`, `secret://keychain/service/account`, or `secret://op/vault/item/field` references. Never put literal credentials in `config.json`. The two credential environment variables below override saved references. Secret values are resolved by the existing broker and registered for scrubbing.

### ntfy

Use a server and account that enforce access control for your topic, allowing only you to publish and subscribe. Supplying authentication proves the sender has credentials; it cannot prove your server's subscription permissions. On shared ntfy hosts, reserve/protect the topic before using it. A random topic is additional protection, not an access-control policy.

```sh
roundtable notify init ntfy
roundtable config set notify.ntfy.url https://ntfy.example.org
roundtable config set notify.ntfy.token secret://keychain/roundtable/notify-ntfy
roundtable notify test
```

`notify init ntfy` generates and saves a random 32-character topic; inspect the private config locally to subscribe from your devices. Topics must contain 16–64 ASCII letters, digits, underscores or hyphens. Authentication is required: use `notify.ntfy.token`, or both `notify.ntfy.user` and `notify.ntfy.password` references. Alternatively set `ROUNDTABLE_NOTIFY_NTFY_TOKEN` in the service's environment. An invalid or unauthenticated sender is refused with a diagnostic; the index and other senders continue. URLs require HTTPS except for loopback development endpoints. Redirects are refused.

### Signed webhook

```sh
roundtable config set notify.webhook.url https://private-receiver.example/check-in
roundtable config set notify.webhook.secret secret://keychain/roundtable/notify-webhook
roundtable notify test
```

`ROUNDTABLE_NOTIFY_WEBHOOK_SECRET` can supply the secret instead. POST bodies are JSON: `{v: 1, kind, execution, tag, title, body, seq, at}`. The receiver verifies `X-Roundtable-Signature: sha256=<hex>` against the HMAC-SHA256 of the **exact raw body bytes** with the shared secret. `X-Roundtable-Timestamp` equals `at`. Verify a reasonable timestamp window and deduplicate execution/kind/sequence/timestamp tuples to reject replays. Keep the receiver private and protect its records. HTTPS is required except on loopback; redirects are refused.

### Desktop

```sh
roundtable config set notify.desktop true
roundtable notify test
```

macOS uses `osascript`; Linux uses `notify-send` if installed. Text is passed as arguments. The service needs access to your logged-in desktop session. Unsupported environments are reported once at startup. Desktop lock-screen previews can expose the short check-in text; configure previews to suit your device.

### Events, delivery and privacy

Defaults: `awaiting_human`, `budget` (80% or more of the current budget), `completed`, `failed`, `aborted`, `postmortem_ready`, and `runner_keeps_dying`. Select events with a comma-separated value or JSON array:

```sh
roundtable config set notify.events awaiting_human,budget,failed,runner_keeps_dying
```

On first seeing an execution the notifier starts at the log's end, skipping historical notifications. Each escalation currently awaiting a human gets one check-in. Cursors and escalation identifiers persist in `serve/notify-state.json` (0600, atomic) across restarts. The watcher supplies current-state classification, so resolved escalations and obsolete budget warnings do not generate pushes.

Messages have a one-line title and a short scrubbed body (at most about 300 characters): a decision summary, or completion and spending. Bodies end with “Answer it from your chat, or run: roundtable status <tag>”. Pushes never contain a capability URL or token, a home-directory path, a run's prompt or persona text, or credentials. The index itself contains more run detail and should be treated as private.

Each channel attempts at most one push every 10 seconds. Updates arriving during that interval coalesce into an “N more updates” check-in. Queues persist across restarts; requests have a 15-second timeout and at most three attempts, retrying only network errors, HTTP 429 or 5xx. Sender failures do not stop supervision. Delivery is best effort: a crash after the receiver accepts a push but before local acknowledgement can repeat it; deduplicate webhook deliveries. `notify test` reports success or a scrubbed error for every configured channel.

## Your own devices over a private tailnet

```sh
roundtable serve --bind tailnet
```

The index binds only to an address assigned to a local interface in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`. Without one it refuses to start. `--bind loopback` is the default. Wildcard binds, public addresses and arbitrary bind values are refused. The HTTP Host header must exactly match the bound address and port (brackets around IPv6); capability checks, strict CSP and read-only routes still apply.

Anyone on your tailnet **with the URL** can read the index. Use tailnet access controls to restrict access to your devices, keep the capability URL private, and avoid sharing it through browser sync or screenshots. This is HTTP over your private tailnet; the tailnet must provide the network confidentiality you need. Interface-range validation does not authenticate a particular VPN product. The service does not install or invoke a tunnel, public relay, or tailnet publishing command.

## Start at login

Print a service definition for review and install it yourself:

```sh
roundtable serve --print-service launchd
roundtable serve --print-service systemd
```

The first prints a macOS LaunchAgent plist; the second prints a systemd user unit. Both run the installed Node executable and CLI with `serve` in the foreground, and restart on failure. They do not embed environment values or credentials and do not install themselves. Save the output yourself under `~/Library/LaunchAgents` or `~/.config/systemd/user`, then use your platform's service manager. Use absolute installed paths that will survive upgrades. For a custom `ROUNDTABLE_HOME`, set that variable through your service manager; otherwise the default home is used. Environment-backed secrets must also be available to that service; keychain references may be more convenient on macOS. Stop an installed service through its manager, which may restart a process stopped by `serve stop`.

A local process cannot run while the computer sleeps or is off. Use an always-on machine and an appropriate login/session policy. `up` remains reserved for the launcher.
