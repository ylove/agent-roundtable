# Secrets

Provider keys can stay in the OS credential store or 1Password instead of a plaintext `.env`. Save references in the owner-controlled `ROUNDTABLE_HOME/config.json` (normally `~/.agent-roundtable/config.json`):

```sh
roundtable config set secret ANTHROPIC_API_KEY secret://keychain/roundtable/anthropic
roundtable config set secret OPENAI_API_KEY secret://op/Work/OpenAI/credential
roundtable config show
roundtable secrets check
roundtable config unset secret OPENAI_API_KEY
```

`config show` prints `ANTHROPIC_API_KEY: keychain`, without the locator or value. `secrets check` checks provider references and connector env references, prints each name with `ok` or a short failure reason, and exits 1 if any resolution fails. No MCP tool resolves or returns credentials.

## References and backends

| Reference | Resolver |
| --- | --- |
| `secret://env/NAME` | Another environment variable in the trusted process. NAME matches `[A-Z_][A-Z0-9_]{0,127}`. |
| `secret://keychain/service[/account]` | macOS `security find-generic-password -s service [-a account] -w`; Linux `secret-tool lookup service service [account account]`. Other platforms are unsupported. |
| `secret://op/vault/item/field` | `op read --no-newline op://vault/item/field`. Install and sign in to the 1Password CLI first. |

Locator segments have 1–128 unreserved URL characters: letters, digits, `_`, `~`, `.`, `-`. Empty segments, `..`, URL escapes, whitespace and control characters are refused. Use store identifiers that fit this form; references are never URL-decoded or normalized. Diagnostics describe the accepted shapes without echoing input.

The CLI backends find an absolute executable on PATH and use separate arguments with no shell. They receive only BASE (`PATH`, `HOME`, user, locale, time zone, temp directory and terminal variables), `OP_*`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`. Keychain requests have a 10-second limit; 1Password has 30 seconds to allow an unlock prompt. Output is capped at 64 KiB, one trailing newline is removed, and empty output is refused. Stderr stays private; errors use short reasons such as `not found`, `locked or denied`, `timed out`, or `op not installed`.

## Startup and precedence

Non-worker startup loads the package `.env`, resolves configured provider references synchronously, then loads the configured env file. For a key with a reference, an existing shell value (including an empty one) wins; the reference beats either plaintext file. Existing package `.env` override behavior is preserved for keys without references. The configured env file still fills only allowed gaps, with its existing endpoint/key pairing rule.

The synchronous bootstrap has a total 20-second budget. An unavailable reference warns, for example, `ANTHROPIC_API_KEY: secret unavailable (locked or denied)`, and leaves the key unset. It does not fall back to a plaintext value for that key. Providers requiring that key are unavailable. `ROUNDTABLE_SECRETS=off` skips startup resolution; `ROUNDTABLE_DOTENV=off` separately skips both env files. Workers and hooks skip user configuration and startup resolution entirely.

Secret names must pass the provider environment allowlist (`allowedEnvKey`, including `OPENAI_COMPATIBLE_*` and allowed model settings), or occur in a configured connector's environment. Invalid entries are ignored with one warning per name per process. Config files must be regular files owned by the current user and not writable by others; config writes are atomic, mode 0600.

## Resolver interface

The in-process registry in `src/secrets/backends.ts` exposes:

```ts
interface SecretBackend {
  id: string;
  resolve(locator: string, options: {
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<string>;
}
registerSecretBackend(backend);
```

Resolvers honor cancellation and time limits, return a non-empty value, and report safe short errors. The broker caches successful values for the process lifetime; failures can be retried. Every result is registered with the exact-value scrubbers immediately. Scrubbers read literals at call time, including short credentials and values under ordinary names. The trusted runner and output relay carry those literals privately.

Cloud managers can implement this interface later, alongside an explicitly validated reference shape and synchronous provider bootstrap support. Doppler and Google Secret Manager are not implemented.

## Threat notes

This protects storage and output sinks; it does not isolate credentials from their owner, the trusted runner, OS inspection or a malicious credential resolver. PATH and the installed `security`, `secret-tool` and `op` binaries are trusted. An unlock prompt can still time out. Cached values do not refresh after rotation until the process restarts. No broker value is saved to disk except the private, temporary worker MCP config described in [connectors](connectors.md).

Exact-value scrubbing covers logs, artifacts, notifications, session archives and worker relay output. It cannot guarantee detection of an intentionally encoded, transformed or split credential. Avoid putting secrets in prompts, arguments or ordinary config literals. Connector programs receive their configured credentials and must be trusted with them.
