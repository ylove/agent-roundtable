# Security policy

This policy covers agent-roundtable 2.0.0 and the maintained 2.x release line.

| Version | Security fixes |
| --- | --- |
| Latest 2.x | Supported |
| Earlier 2.x patch/minor releases | Upgrade to the latest 2.x |
| 1.x and earlier | Not supported (1.x was never published to npm) |

## Reporting a vulnerability

Private vulnerability reporting is enabled for this repository.

Use this repository's [private vulnerability reporting form](https://github.com/ylove/agent-roundtable/security/advisories/new), available from **Security → Advisories → Report a vulnerability**. Keep exploit details private while maintainers investigate. Include the affected version, platform, configuration (especially worker driver and sandbox backend), reproduction steps, impact and any suggested fix. Remove credentials, personal information and private repository content from reports and attachments.

Maintainers aim to acknowledge reports within **3 business days**, provide an initial assessment within **7 business days**, and agree on remediation and coordinated disclosure with the reporter. These are response targets, not a guaranteed resolution deadline. Follow up in the private advisory if a response is late. Fixes and disclosure will be tracked through a GitHub Security Advisory for this repository; ordinary non-sensitive bugs can use public issues.

## Scope and security model

In scope are the npm package, its MCP tools, provider and publishing integrations, generated worker configuration, command sandbox, local state and logs, dashboard and prototype board, GitHub sync, and the build/release workflows. Report failures of documented isolation, authorization, redaction, SSRF protection or supply-chain controls, including ways malicious repository content can bypass them.

agent-roundtable is **local-first**: a trusted MCP host launches a stdio server under the operator's account. There is no hosted agent-roundtable service. The dashboard and prototype board listen only on loopback and require capability URLs; the dashboard's one control, stopping an agent, is protected against cross-site requests as well. Selected providers still receive prompts and context, and enabling public publishing or GitHub sync deliberately sends selected data to those services. Public channel links are not private access controls.

Provider keys are loaded by the orchestrator from local configuration; the trusted runner is designed to hold them too. Child processes use profiles from `src/security/child-env.ts`; worker MCP servers are specified to skip dotenv and hold no provider keys. Worker CLIs use their own login by default, with explicit API-key/cloud-auth exceptions. The runner profile intentionally inherits the environment. Recorded free-text fields use configured-secret value matching and credential patterns. Newly launched workers write stdout/stderr through a detached scrubbing relay before the 0600 run log is appended; it survives runner restart without a raw spool. Public messages/metadata, GitHub bodies and public prototype source apply exact configured-secret matching first, then credential patterns and PII redaction. Matching covers secret-named environment values of at least eight characters (the relay uses its launch-time environment); encoded, transformed, multiline or unrecognized secrets and confidential prose may escape. Existing logs are not retroactively scrubbed. Identifiers and paths are not universally scrubbed. Protect `.env`, CLI credential stores, local state and capability URLs as sensitive data.

Commands and checks use the Docker sandbox by default: no command network access, non-root execution, read-only root and `.git`, dropped capabilities, resource limits and a validated environment. Dependency installation may use an explicit host allowlist through an egress proxy. The local backend requires opt-in and is weaker; isolation may degrade to network-only or no isolation and must be surfaced to the operator. Worker CLIs themselves are distinct from these command containers. Claude workers are specified to have no Bash and use sandboxed `run_command`; Codex is an opt-in driver with broader read access and submission-time lease checks. External workers are unsandboxed and trusted like the host chat.

The [October 2026 security audit](docs/security/audit-2026-10.md) lists the hardening completed. The [threat model](docs/THREAT_MODEL.md) records implementation references and residual risks. The [controls mapping](docs/SECURITY_CONTROLS.md) identifies evidence and integration work still required. Worker drivers, runner/CLI wiring, escalation handling and retention are implemented in this release tree. Offline integration tests cover their behavior; platform sandbox, real-browser and live-service checks still require the appropriate environment.

## Release controls

The default branch and version tags are protected by repository rulesets. Dependency alerts and security updates are enabled. Releases are published by a manually dispatched workflow from a protected `release` environment, limited to version tags with required review. Build and validation run separately with read-only permissions; only the publish job receives OIDC permission and the npm publish step receives the npm token. The release includes the package tarball and CycloneDX SBOM, and npm publication uses provenance. See the [release checklist](docs/distribution.md#owner-release-checklist).

## Deployment limits and operator responsibilities

1.0 heads-down runs support **macOS and Linux**, one host per state directory, and one trusted operator. Windows heads-down runs, hosted or multi-user deployments, untrusted tenants sharing an account/state directory, and a compromised host, OS, Docker daemon or CLI binary are outside the supported isolation model. Unexpected behavior within the supported model remains reportable.

Operators control repository trust, MCP permissions, provider/registry origins, egress allowlists, CLI and git configuration, credentials and budgets. Review generated changes and validation results before merging: the design never auto-merges or pushes to the base branch. Operators also own access reviews, endpoint security, backups, retention enforcement and incident response. This project makes no SOC 2 certification claim.
