// System-prompt text for prototype mode (appended when a session starts with prototype: true).

export function buildPrototypeDirective(opts: { assessorIsCaller: boolean; public: boolean }): string {
  const assessors = opts.assessorIsCaller
    ? "the person you're meeting with assesses your prototype"
    : "the other participants assess your prototype";
  const lines = [
    "",
    "",
    "## Prototype mode",
    "Show, don't just tell. When you propose something concrete, build a small prototype of it so it can be judged on the artifact itself, not on your description. " +
      `The prototype is served read-only to the human, and ${assessors}.`,
    "",
    "When you propose, emit exactly one block in this format (at most one per turn):",
    "",
    '<prototype title="Short title" kind="web|code|diagram|text" entry="index.html">',
    '<file path="index.html">…file content…</file>',
    "<demo>…walkthroughs…</demo>",
    "</prototype>",
    "",
    "Choosing the kind:",
    "- web: a scaled-down page showing just the one page or element being proposed, shown at desktop and mobile widths. " +
      "It runs in a sandboxed, network-restricted frame that can load only its own files, so: " +
      'self-contained HTML, CSS and JavaScript; classic <script> tags only (no type="module", no ES import); ' +
      "inline any data (no fetch or XHR of other files); no external network calls or CDNs; no localStorage, sessionStorage or cookies.",
    "- code: when a running page isn't feasible, the artifact that WOULD produce the proposal when executed (for example CREATE TABLE or CREATE DATABASE statements, or Terraform). It is never executed.",
    "- diagram: abstract or non-replicable proposals, as Mermaid source in a single .mmd file.",
    "- text: text proposals, as draft 1 in a single .md or .txt file.",
    "Rules: 1 to 10 files, at most 100 KB in total, relative paths only (letters, digits, \".\", \"_\", \"-\"; at most 4 levels; no \"..\"). Put each file's raw content inside its <file> element.",
    "Replies have a length cap, so keep the whole block compact (aim for under about 20 KB): a block cut off before </prototype> is rejected.",
    "",
    "If the proposal involves user interaction, <demo> is REQUIRED: walk through it for at least three user types or modalities " +
      "(for example an impatient user, a drunk or otherwise impaired user, an expert, a non-technical user; on mobile, on desktop, with the network interrupted), " +
      "step by step, showing where each one succeeds or struggles.",
    "",
    "Prototypes get ids (P1, P2, …) and versions (P1 v1, P1 v2, …).",
  ];
  if (opts.assessorIsCaller) {
    lines.push(
      "Proposer: after the person you're meeting with has given their verdict, give a line " +
        "`Decision on Pn: REVISE|SCRAP|SHORTLIST — reason`. REVISE must include a new " +
        '<prototype revises="Pn"> block in the same turn. SHORTLIST means it is chosen to show the human.'
    );
  } else {
    lines.push(
      "Assessing: when another participant's prototype is open, give a line `Verdict on Pn: APPROVE|REVISE|REJECT — reason` " +
        "grounded in the artifact itself (and the demo), not in its description. Put it on its own line; you may also discuss and propose in the same turn.",
      "Proposer: after the verdicts arrive, give a line `Decision on Pn: REVISE|SCRAP|SHORTLIST — reason`. REVISE must include a new " +
        '<prototype revises="Pn"> block in the same turn. SHORTLIST means it is chosen to show the human.'
    );
  }
  lines.push(
    "",
    "Prototypes are ephemeral: each one is destroyed as soon as it has been assessed. Never include credentials, personal data or existing private source code in a prototype; write fresh, illustrative code."
  );
  return lines.join("\n");
}

/** Appended AFTER the public-session notice in public prototype sessions. */
export function publicPrototypeAmendment(): string {
  return (
    "Prototype exception: prototype code you write fresh for this session is allowed in <prototype> blocks. " +
    "Never reproduce existing or private source code, credentials or personal data."
  );
}
