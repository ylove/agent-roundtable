// Independent examples of the Claude Code frontmatter and workshop contracts.
const wrap = block => `---\n${block}\n---\n\nYou review shell work.\n`;
export const guard = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] };
const hooks = "hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./guard.sh";
export const frontmatterCases = [
  { name: "strict", text: wrap('name: reviewer\ndescription: "Review work"\ntools: Read'), data: { name: "reviewer", description: "Review work", tools: "Read" } },
  { name: "generator", text: wrap('name: reviewer\ndescription: Use this agent when: shell work. Examples: <example>Context: release'), data: { name: "reviewer", description: "Use this agent when: shell work. Examples: <example>Context: release" } },
  { name: "bracket-hooks", text: wrap(`name: reviewer\ndescription: [Beta] Use this agent when: shell work\n${hooks}`), data: { name: "reviewer", description: "[Beta] Use this agent when: shell work", hooks: guard } },
  { name: "tab-hooks", text: wrap('name: reviewer\ndescription: Review work\nhooks:\n\tPreToolUse:\n\t\t- matcher: Bash\n\t\t  hooks:\n\t\t    - type: command\n\t\t      command: ./guard.sh'), data: { name: "reviewer", description: "Review work", hooks: guard } },
  { name: "folded-retry", text: wrap('name: reviewer\ndescription: Use when: shell work\ncolor: >\n  blue'), data: {}, parseError: true },
  { name: "flow-array", text: wrap('name: reviewer\ndescription: Use when: shell work\nskills: [a, b]'), data: { name: "reviewer", description: "Use when: shell work", skills: ["a", "b"] } },
  { name: "dormant", text: wrap('name: reviewer\nbroken:\n  nested: [unfinished\npermissionMode: bypassPermissions'), data: {}, parseError: true },
  { name: "embedded-fence", text: wrap('name: reviewer\ndescription: Review --- shell work\ntools: Read'), data: { name: "reviewer", description: "Review" }, fenceMismatch: true },
  { name: "bom", text: '\ufeff' + wrap('name: reviewer\nskills: [a, b]'), data: { name: "reviewer", skills: ["a", "b"] } },
  { name: "empty", text: wrap(''), data: {} },
  { name: "scalar", text: wrap('hello'), data: {} },
  { name: "no-newline", text: '---name: reviewer\n---\nBody', data: {}, hasFrontmatter: false },
  { name: "opening-whitespace", text: '--- \t\n\nname: reviewer\n---\nBody', data: { name: "reviewer" } },
];
export const definition = {
  name: "reviewer", description: "Review --- shell ---- work", tools: ["Read"],
  system_prompt: "You review shell work.", skills: [], contributions: [],
};
export const derivedMarker = "SKILL-INSTRUCTIONS-MARKER";
export const newSkill = { name: "release-check", description: "Release --- checklist", instructions: "Check the release.", contributed_by: ["reviewer"] };
export const dashVerdicts = [
  ["Verdict: APPROVE WITH CHANGES—see amendments", "Verdict", ["APPROVE", "APPROVE WITH CHANGES", "OBJECT"], "APPROVE WITH CHANGES"],
  ["Sign-off: OBJECT—the budget", "Sign-off", ["APPROVE", "APPROVE WITH RESERVATIONS", "OBJECT"], "OBJECT"],
  ["Sign-off: APPROVE WITH RESERVATIONS–timeline", "Sign-off", ["APPROVE", "APPROVE WITH RESERVATIONS", "OBJECT"], "APPROVE WITH RESERVATIONS"],
  ["Verdict: NEEDS CHANGES—tools too broad", "Verdict", ["READY", "NEEDS CHANGES"], "NEEDS CHANGES"],
];
export const privatePassage = "PERSONA-MARKER: runway is 9 months.";
export const quotedPrivateMetadata = {
  description: `Refined guidance for '${privatePassage}'`,
  changes: [`Replaced '${privatePassage}' with a general cash-planning rule`],
  open_questions: [`Should '${privatePassage}' remain?`],
  contributions: [{ agent: "reviewer", summary: `Clarified '${privatePassage}'` }],
};
