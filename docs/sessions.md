# Session state and archives

- Active at-the-table state is in memory. A rebuild + reconnect drops every meeting, collaboration and open ultraplan. Activity records, archived sessions and written agent/skill files remain local on disk. Heads-down runs persist separately and survive reconnects; see [resume](heads-down.md#resume-and-recovery).
- Every session is archived when it ends (meetings, local meetings, collaborations, ultraplans when finalized or ended, and agent workshops) to `~/.agent-roundtable/sessions/<id>.json` under `ROUNDTABLE_HOME`: the participants, topic, the transcript as agents saw it, the summary, the ultraplan document with its versions and sign-offs, or the workshop result. Directories are 0700, files 0600, writes are atomic, and secrets are redacted first. Archiving never fails a session; a failed write is logged to stderr.
- Session ids are a prefix plus 8 random characters (`meeting-`, `local-`, `collab-`, `ultraplan-`, `create-`, `improve-`), so an id from before a restart never points at a different session.
- Local meetings require the `claude` CLI on `PATH`.
- The smoke test pins temporary directories and test configuration after loading `.env`, and stubs every fetch. Local credentials or endpoint settings cannot enable network calls or home-directory writes in it.
- Provider errors (missing key, empty reply, timeout, unknown model) surface as tool errors with the reason; they never abort the server.

Archived sessions and terminal runs are swept at server startup: defaults are 30 days each, and audit months 365 days. `0` or `off` disables the relevant retention policy; see [configuration](configuration.md). Public transcripts, backups and remote copies need their own retention policy.
