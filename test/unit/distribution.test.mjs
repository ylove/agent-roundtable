import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (p) => readFileSync(join(root, p), "utf8");
const json = (p) => JSON.parse(text(p));

const pkg = json("package.json");
const server = json("server.json");
const plugin = json("plugins/agent-roundtable/.claude-plugin/plugin.json");
const market = json(".claude-plugin/marketplace.json");
const mcp = json("plugins/agent-roundtable/.mcp.json");
const dockerfile = text("Dockerfile");
const dockerignore = text(".dockerignore");
const versionDocs = ["README.md", "docs/getting-started.md", "docs/distribution.md"];

const added = [
  "Dockerfile", ".dockerignore", "server.json", ".claude-plugin/marketplace.json", "scripts/sync-version.mjs",
  "plugins/agent-roundtable/.claude-plugin/plugin.json", "plugins/agent-roundtable/.mcp.json",
  "plugins/agent-roundtable/README.md", "docs/distribution.md",
];

test("every distribution file carries the package.json version", () => {
  const v = pkg.version;
  assert.equal(server.version, v);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, "npm");
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, v);
  assert.equal(plugin.version, v);
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry);
  assert.equal(entry.version, v);
  assert.equal(entry.source, "./plugins/agent-roundtable");
  assert.ok(existsSync(join(root, entry.source, ".claude-plugin/plugin.json")));
  assert.deepEqual(mcp.mcpServers.roundtable.args, ["--prefix", "${CLAUDE_PLUGIN_ROOT}", "-y", `${pkg.name}@${v}`, "mcp"]);
  assert.match(text("src/config.ts"), new RegExp(`^export const VERSION = "${v.replace(/\./g, "\\.")}";$`, "m"));
});

test("plugin package resolution uses the plugin root independently of the opened project", () => {
  const { command, args } = mcp.mcpServers.roundtable;
  assert.equal(command, "npx");
  assert.equal(args[args.indexOf("--prefix") + 1], "${CLAUDE_PLUGIN_ROOT}");
  assert.ok(args.indexOf("--prefix") < args.indexOf(`${pkg.name}@${pkg.version}`));
  assert.ok(args.every(arg => !/^\.{1,2}(?:[\\/]|$)/.test(arg)), "no relative path arguments");
  assert.equal(mcp.mcpServers.roundtable.cwd, undefined, "the server retains the opened project's cwd");
});

test("documented npx commands use the current package version", () => {
  for (const path of versionDocs) {
    const commands = [...text(path).matchAll(/\bnpx\b[^\n`]*?\bagent-roundtable(?:@[^\s`"']+)?/g)];
    assert.ok(commands.length, path);
    for (const [command] of commands) assert.ok(command.endsWith(`agent-roundtable@${pkg.version}`), `${path}: ${command}`);
  }
});

test("server.json follows the registry schema shape", () => {
  assert.equal(server.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(server.description.length >= 1 && server.description.length <= 100);
  assert.equal(server.repository.source, "github");
  const pkgEntry = server.packages[0];
  assert.deepEqual(pkgEntry.transport, { type: "stdio" });
  assert.deepEqual(pkgEntry.packageArguments, [{ type: "positional", value: "mcp" }]);
  for (const e of pkgEntry.environmentVariables) {
    assert.equal(e.isSecret, true);
    assert.equal(e.isRequired, false);
    assert.ok(e.name && e.description);
  }
  assert.ok(!server.packages.some((p) => p.registryType === "oci"), "no OCI entry until an image is published");
});

test("registry name, mcpName and the Docker label agree", () => {
  assert.equal(pkg.mcpName, server.name);
  const m = dockerfile.match(/io\.modelcontextprotocol\.server\.name="([^"]+)"/);
  assert.ok(m);
  assert.equal(m[1], pkg.mcpName);
});

test(".dockerignore keeps secrets and the repo history out of the build context", () => {
  const lines = dockerignore.split("\n").map((l) => l.trim());
  for (const need of [".env", ".env.*", ".git", "node_modules", "dist", ".claude", "test"]) assert.ok(lines.includes(need), need);
  assert.doesNotMatch(dockerfile, /^\s*ARG\s+\w*(KEY|TOKEN|SECRET)/mi);
  assert.doesNotMatch(dockerfile, /\.env/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\} AS runtime$/m);
  assert.match(dockerfile, /node:[\w.-]+@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /^COPY examples \.\/examples$/m, "duel --dry-run and the starter pack read examples/ at runtime");
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS build[\s\S]*?^RUN npm ci --ignore-scripts$/m);
  assert.match(dockerfile, /^RUN npm run build$/m);
  assert.match(dockerfile, /mkdir -m 0700 -p "\$ROUNDTABLE_HOME"/);
});

test("sandbox and proxy defaults are digest-pinned Docker image references", async () => {
  const { DEFAULT_SANDBOX_IMAGE, DEFAULT_PROXY_IMAGE } = await import("../../dist/sandbox/common.js");
  const { IMAGE_RE } = await import("../../dist/sandbox/docker.js");
  for (const image of [DEFAULT_SANDBOX_IMAGE, DEFAULT_PROXY_IMAGE]) {
    assert.match(image, /@sha256:[0-9a-f]{64}$/);
    assert.match(image, IMAGE_RE);
  }
});

test("added files contain no key-shaped values", () => {
  const re = /(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
  for (const f of added) assert.doesNotMatch(text(f), re, f);
  assert.doesNotMatch(JSON.stringify(mcp), /"env"/, "plugin .mcp.json carries no env values");
});

test("no workflow other than the manual release publishes or logs in", () => {
  const dir = join(root, ".github/workflows");
  for (const f of readdirSync(dir)) {
    if (f === "release.yml") continue;
    assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /npm publish|docker push|docker login|mcp-publisher/, f);
  }
  assert.match(readFileSync(join(dir, "release.yml"), "utf8"), /on:\s*\n\s*workflow_dispatch:/);
});

test("release permissions and credentials are scoped to the protected publish job", () => {
  const release = text(".github/workflows/release.yml");
  const [build, publish] = release.split(/^  publish:\s*$/m);
  assert.ok(publish);
  assert.match(build, /^permissions:\n  contents: read\n/m);
  assert.match(build, /^  build:\n    if: github\.ref_type == 'tag'/m);
  assert.doesNotMatch(build, /id-token:|NPM_TOKEN|secrets\.|registry-url:|cache:/);
  assert.equal((release.match(/id-token: write/g) ?? []).length, 1);
  assert.match(publish, /^    needs: build$/m);
  assert.match(publish, /^    if: github\.ref_type == 'tag'$/m);
  assert.match(publish, /^    environment: release$/m);
  assert.match(publish, /^      contents: write\n      id-token: write$/m);
  assert.doesNotMatch(publish, /actions\/checkout/);
  assert.doesNotMatch(release, /^\s*(pull_request(?:_target)?|push):/m);
  assert.equal((release.match(/NPM_TOKEN/g) ?? []).length, 1);
  assert.match(publish, /Publish with provenance[\s\S]*?npm publish "\.\/\$PACKAGE_FILE" --provenance --access public --ignore-scripts\n        env:\n          NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  for (const script of release.matchAll(/^        run: \|\n((?:          .*\n|\n)*)/gm)) assert.doesNotMatch(script[1], /\$\{\{/);
});

test("release artifacts include the packed package and its SBOM", () => {
  const release = text(".github/workflows/release.yml");
  assert.match(release, /npm pack --json --ignore-scripts > pack\.json/);
  assert.match(release, /npm sbom --sbom-format cyclonedx --omit dev > sbom\.cdx\.json/);
  assert.match(release, /path: \|\n            \*\.tgz\n            package-name\.txt\n            sbom\.cdx\.json\n          if-no-files-found: error/);
  assert.match(release, /gh release create "\$GITHUB_REF_NAME" --verify-tag --generate-notes "\.\/\$PACKAGE_FILE" \.\/sbom\.cdx\.json/);
  assert.match(release, /gh release upload "\$GITHUB_REF_NAME" --clobber "\.\/\$PACKAGE_FILE" \.\/sbom\.cdx\.json/);
  assert.match(release, /GH_REPO: \$\{\{ github\.repository \}\}/);
});

test("every workflow action is pinned to a full commit SHA", () => {
  for (const file of readdirSync(join(root, ".github/workflows"))) {
    for (const [, action] of text(`.github/workflows/${file}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert.match(action, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${action}`);
    }
  }
});

test("CodeQL uses the security-extended query suite", () => {
  assert.match(text(".github/workflows/codeql.yml"), /^          queries: security-extended$/m);
  assert.match(text(".github/codeql/codeql-config.yml"), /^queries:\n  - uses: security-extended$/m);
});

test("the npm tarball ships neither the container, plugin, registry nor secret files", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  const paths = JSON.parse(out)[0].files.map((f) => f.path);
  for (const p of paths) {
    assert.doesNotMatch(p, /^(Dockerfile|\.dockerignore|server\.json|plugins\/|\.claude-plugin\/|test\/|scripts\/)/, p);
    assert.doesNotMatch(p, /(^|\/)\.env$/, p);
  }
  assert.ok(paths.includes("dist/index.js"));
});

test("sync-version.mjs is idempotent on a consistent tree", () => {
  const synced = [...added.slice(0, 7), "src/config.ts", ...versionDocs];
  const before = synced.map(text);
  execFileSync("node", ["scripts/sync-version.mjs"], { cwd: root });
  assert.deepEqual(synced.map(text), before);
});

test("version sync updates only npx package forms in documentation and is repeatable", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rt-distribution-"));
  try {
    const files = ["package.json", "server.json", ".claude-plugin/marketplace.json", "plugins/agent-roundtable/.claude-plugin/plugin.json", "plugins/agent-roundtable/.mcp.json", "src/config.ts", "scripts/sync-version.mjs", ...versionDocs];
    for (const path of files) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), text(path));
    }
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ ...pkg, version: "3.4.5-beta.1" }));
    const doc = '`npx -y agent-roundtable mcp`\n`npx --prefix "${CLAUDE_PLUGIN_ROOT}" -y agent-roundtable@1.2.3 mcp`\n`npx -y agent-roundtable@2.0.0-rc.1 mcp`\n`npm install agent-roundtable@1.2.3`\n`agent-roundtable@1.2.3`\n`npx -y other-agent-roundtable@1.2.3`\n`npx -y agent-roundtable-tools@1.2.3`\n`npx -y @example/agent-roundtable@1.2.3`\n';
    for (const path of versionDocs) writeFileSync(join(fixture, path), doc);
    execFileSync(process.execPath, ["scripts/sync-version.mjs"], { cwd: fixture });
    const expected = doc.replace(/agent-roundtable(?= mcp)|agent-roundtable@(?:1\.2\.3|2\.0\.0-rc\.1)(?= mcp)/g, "agent-roundtable@3.4.5-beta.1");
    for (const path of versionDocs) assert.equal(readFileSync(join(fixture, path), "utf8"), expected);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, "plugins/agent-roundtable/.mcp.json"), "utf8")).mcpServers.roundtable.args, ["--prefix", "${CLAUDE_PLUGIN_ROOT}", "-y", "agent-roundtable@3.4.5-beta.1", "mcp"]);
    execFileSync(process.execPath, ["scripts/sync-version.mjs"], { cwd: fixture });
    for (const path of versionDocs) assert.equal(readFileSync(join(fixture, path), "utf8"), expected);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
