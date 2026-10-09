export const generatorFrontmatter = [
  "---",
  "name: code-reviewer",
  "description: Use this agent when: the user asks. Examples: <example>Context: x</example>",
  "tools: Read, Grep",
  "model: opus",
  "permissionMode: plan",
  "color: red",
  "skills: ledger",
  "---",
  "Review the code."
].join("\n");

export const unreadableFrontmatter = "---\ndescription:\n   indented: [unclosed\n---\nBody";
