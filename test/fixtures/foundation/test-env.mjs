// Import before test files so config defaults can never write into the real home directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "roundtable-test-env-"));
process.env.ROUNDTABLE_HOME = join(root, "state");
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
process.env.ROUNDTABLE_AGENTS_DIR = join(root, "agents");
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
// Prototype sandboxes live under the temp root too, and tests never open a browser.
process.env.ROUNDTABLE_PROTOTYPE_DIR = join(root, "prototypes");
delete process.env.ROUNDTABLE_PROTOTYPE_OPEN;
// Never spawn a real browser for screenshots unless the opt-in Chrome test is requested.
if (process.env.ROUNDTABLE_TEST_CHROME !== "1") process.env.ROUNDTABLE_PROTOTYPE_SCREENSHOTS = "0";
// Personal skills (~/.claude/skills) take precedence over project skills: never read the developer's.
process.env.HOME = join(root, "home");
// Path-like agent refs must stay inside allowed roots; tests pass fixture paths under test/fixtures.
process.env.ROUNDTABLE_AGENT_PATHS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
