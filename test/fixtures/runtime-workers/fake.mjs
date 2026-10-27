// Fake runtime CLIs for the runtime worker tests (hermes, openclaw, gemini). What a run does is
// named in the prompt: "FIXTURE write <path>", "FIXTURE fail", "FIXTURE hang", "FIXTURE secret".
// A REPORT line on stderr says how the CLI was started.
import { basename } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const name = basename(process.argv[2] ?? process.argv[1]);
const args = process.argv.slice(3);
if (args.includes("--version")) {
  console.log(`${name} fixture 1.0`);
  process.exit(0);
}
let prompt = "";
const at = args.findIndex((a) => a === "-q" || a === "-p" || a === "--message");
if (at >= 0) prompt = args[at + 1] ?? "";
else for await (const chunk of process.stdin) prompt += chunk;

const report = {
  runtime: name,
  argv: args.map((a, i) => (i === at + 1 ? "<prompt>" : a)),
  promptOnArgv: at >= 0,
  promptBytes: prompt.length,
  cwd: process.cwd(),
  envNames: Object.keys(process.env).sort(),
  term: process.env.TERM,
  noColor: process.env.NO_COLOR,
};
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
if (settingsPath) {
  report.settingsPath = settingsPath;
  report.settings = JSON.parse(readFileSync(settingsPath, "utf8"));
}
console.error("REPORT " + JSON.stringify(report));

let summary = `Finished the task (${name}).`;
for (const m of prompt.matchAll(/FIXTURE (\S+)(?: (\S+))?/g)) {
  const [, op, arg] = m;
  if (op === "write") {
    mkdirSync(dirname(arg), { recursive: true });
    writeFileSync(arg, `// written by ${name}\n`);
  } else if (op === "fail") {
    console.error("the runtime failed on purpose");
    process.exit(3);
  } else if (op === "hang") {
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  } else if (op === "secret") {
    summary = `Used ghp_${"Z".repeat(30)} to finish.`;
  }
}
if (name === "agy") {
  const failed = prompt.includes("FAIL_ME");
  const denied = prompt.includes("DENY_ME");
  console.log(JSON.stringify({
    status: failed ? "ERROR" : "SUCCESS", response: failed || denied ? "" : summary,
    ...(failed && { error: "boom" }),
    ...(denied && { denied_actions: [{ action: "write_file" }] }),
    usage: { input_tokens: 7709, output_tokens: 1, thinking_tokens: 20 },
  }));
} else if (name === "gemini") {
  console.log(JSON.stringify({ response: summary, stats: { tokens: { input: 120, output: 30 }, cost: 0.004 } }, null, 2));
} else console.log(`Hermes Agent fixture banner\n${summary}`);
