// Import before test files so config defaults can never write into the real home directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "roundtable-test-env-"));
process.env.ROUNDTABLE_ACTIVITY_LOG = join(root, "activity.jsonl");
process.env.ROUNDTABLE_AGENTS_DIR = join(root, "agents");
process.env.ROUNDTABLE_SKILLS_DIR = join(root, "skills");
process.env.ROUNDTABLE_WORKSPACE_DIR = root;
process.env.ROUNDTABLE_TRANSCRIPTS_DIR = join(root, "transcripts");
// Personal skills (~/.claude/skills) take precedence over project skills: never read the developer's.
process.env.HOME = join(root, "home");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
