# Von Neumann Dashboard

A conversational AWS dashboard: ask questions, build charts/tables, or create interactive widgets. Each dashboard has its own Next.js development server and Git branch. This is an innovation-day prototype for a trusted workspace, **not a security-audited multi-tenant SaaS**.

## Two repositories

| Repository | Contents |
| --- | --- |
| `von-neumann-platform` (this one) | Backend, connector gateway, AI tools, authentication, SQLite, Docker and CloudFormation |
| `von-neumann-dashboard` | Empty Next.js template, trusted widgets, chat shell and isolated custom-widget renderer |

Clone the template into the ignored `dashboard-base/` directory. Replace `YOUR_OWNER`:

```bash
git clone https://github.com/YOUR_OWNER/von-neumann-platform.git
cd von-neumann-platform
git clone https://github.com/YOUR_OWNER/von-neumann-dashboard.git dashboard-base
npm ci
npm ci --prefix dashboard-base
```

Prerequisites: Node.js 22.13+, npm, Git; Docker Engine 26+ with Compose v2 for isolated sessions; AWS CLI v2 for AWS deployment. The AWS host uses ARM64 Amazon Linux 2023. Keep both repository revisions and lockfiles together when releasing.

## Local demo

```bash
npm run bootstrap
AI_PROVIDER=demo AWS_MODE=demo npm run dev
```

Open `http://localhost:3000`. Bootstrap creates an ignored `.env` with random `ADMIN_PASSWORD` and `SESSION_SECRET`. Read the password **locally**, never paste it into chat or commit it. Set `PORT` and `PUBLIC_URL` if another service uses that port. Process-mode development is for trusted local use, not hostile code isolation.

For Docker (build both images first):

```bash
docker compose --profile build build
docker compose -f compose.yaml -f compose.demo.yaml up -d platform
```

Local Compose binds to loopback and stores data in the `von-neumann-data` volume, separately from local-process `.data/`. On Linux set `DOCKER_GID` to the Docker socket group. The backend requires the Docker socket: treat it as host-administrator authority and use a dedicated host. Never mount that socket into a generated session. `docker compose stop` pauses the local copy without deleting data.

## Deploy into your own AWS account

No original account, IAM user, domain, resource ID or credential is required. Use a dedicated sandbox/account and an operator profile authorized to manage the resources in the templates (including IAM, VPC/EC2, S3, Route53, Secrets Manager, CloudWatch and Backup). Review the templates before granting deployment permissions; the deployment identity is **not** the application's read-only identity.

The deployment creates:

- `<project>-foundation`: delegated Route53 zone, private encrypted/versioned release bucket, four retained secrets.
- `<project>-application`: dedicated VPC, ARM `t4g.large`, static public IP, encrypted retained 80 GiB data disk, 24 GiB root disk, Caddy HTTPS, application IAM role, logs and daily backups.

This is single-host, not HA/serverless. Compute, storage, IPv4, DNS, backups, logs, secrets and model calls cost money. Set account budgets/alerts independently; application quotas are not a billing cap. Templates target commercial AWS; other partitions require adaptation/testing.

### 1. Choose account, domain, region and model

Authenticate with your normal AWS CLI/SSO workflow. Replace every placeholder; none of these variables should contain secret values:

```bash
export AWS_PROFILE=your-deployment-profile
aws sso login --profile "$AWS_PROFILE" # only for SSO profiles
aws sts get-caller-identity --profile "$AWS_PROFILE"
export DEPLOY_ACCOUNT_ID=YOUR_12_DIGIT_ACCOUNT_ID
export DEPLOY_REGION=eu-west-1
export DEPLOY_PROJECT_NAME=von-neumann
export DEPLOY_DOMAIN=dashboard.your-domain.tld
export DEPLOY_BEDROCK_MODEL=YOUR_ACCESSIBLE_MODEL_OR_INFERENCE_PROFILE_ID
export DEPLOY_INVENTORY_REGIONS="$DEPLOY_REGION"
```

Choose a tool-use capable Bedrock model accessible in your account/region. Model entitlement, quotas, inference-profile destination regions and organization SCPs must permit it. Discover IDs using `aws bedrock list-inference-profiles --region "$DEPLOY_REGION"` or `list-foundation-models`. The script resolves exact invoke ARNs, not a wildcard permission to all models. It supports foundation-model IDs and AWS geographic/global inference-profile IDs, not custom application-profile ARNs. Discovery does not prove inference permission: verify a small billable request separately if needed.

The script verifies STS against `DEPLOY_ACCOUNT_ID`. `DEPLOY_PROFILE` overrides `AWS_PROFILE`. Changing project name selects different stack/secret names. Use a separate checkout/private state directory per deployment; do not overwrite another deployment's state.

### 2. Create infrastructure

```bash
node scripts/deploy-aws.mjs
```

The script creates the foundation, packages both source trees, uploads the release, and creates the application. CloudFormation completion does **not** mean bootstrap/TLS is ready. Save `.data/aws-deployment.json` privately: profile, account, stack names, URLs and resource/secret ARNs are stored there, not secret values. If application creation fails, `.data/aws-foundation.json` retains foundation outputs for recovery.

Archives exclude Git history, dependencies/build output, local environments, credential files and DNS exports. Never store credentials in source under another filename. EC2 is seeded from the cloned template without needing GitHub credentials.

### 3. Delegate DNS and verify startup

```bash
DNS_PARENT_ZONE=your-domain.tld node scripts/export-dns.mjs
```

Import `.data/dns-delegation.bind` into the **existing parent zone** at Cloudflare/your DNS provider. It contains only subdomain NS delegation records. Do not change registrar nameservers. Remove conflicting records at that subdomain if necessary; its A record is managed in Route53. Allow propagation; check `dig NS dashboard.your-domain.tld` and `dig A dashboard.your-domain.tld`.

```bash
node scripts/aws-command.mjs 'test -f /var/lib/von-neumann-ready && echo ready'
node scripts/aws-command.mjs 'tail -n 40 /var/log/von-neumann-bootstrap.log'
curl --fail https://dashboard.your-domain.tld/healthz
```

SSM can take several minutes to connect while images build. Ports 80/443 are public for HTTPS/ACME; SSH is not. The proxy supports WebSockets for hot reload and SSE for agent responses.

### 4. Sign in and select connector scope

Secrets Manager entries are `<project>/prod/admin-password`, `session-secret`, `aws-connector` and `ai`. Password/cookie secrets are generated. AWS and Bedrock use temporary **instance-role credentials**: no static AWS/AI key is necessary.

Retrieve the password in your own terminal or Secrets Manager console. This command intentionally prints a secret; do not execute it in an AI tool transcript or share its output:

```bash
aws secretsmanager get-secret-value --region "$DEPLOY_REGION" \
  --secret-id "$DEPLOY_PROJECT_NAME/prod/admin-password" \
  --query SecretString --output text
```

Initial connector settings allow only the deployed host and its log group. Explicitly opt into account-wide resource metadata/metrics and CloudWatch logs in your selected regions:

```bash
node scripts/discover-aws.mjs
node scripts/enable-inventory.mjs
node scripts/aws-command.mjs 'cd /opt/von-neumann && docker compose --env-file /etc/von-neumann/runtime.env -f deploy/aws/compose.yaml restart platform'
```

Discovery saves private metadata in `.data/aws-inventory.json` across enabled regions. The enable helper verifies the discovery account and uses `DEPLOY_INVENTORY_REGIONS` (or the deployment region only), not all discovered regions automatically. IAM and connector regions must agree. DynamoDB contents remain restricted: inventory does not grant Scan/Query. SQL, S3 object contents, secret values and Lambda environment variables are not exposed. Logs/metadata can still contain sensitive information and requested results can go to your AI provider.

Customize secrets through the console or an SDK reading an ignored local file. Never put secret values in chat, Git, command arguments or SSM commands. Schemas are in `server/secrets.ts`; restart the platform after changes. Reapplying a changed foundation `SecretString` can overwrite customizations: use code-only releases routinely and review infrastructure changes.

## Pause, resume and release

```bash
npm run project:status
npm run project:disable
# Only when intentionally bringing it online:
node scripts/project-control.mjs plan-enable
npm run project:enable
```

Commands use private deployment state and verify account/resource ownership. Disable stops EC2, sets `ProjectEnabled=false`, removes all ingress and denies all application-role AWS access. Accidentally starting EC2 does not restore ingress/permissions. Enable reverses that switch and waits for HTTPS, attempting to disable again if startup fails. Changes beyond in-place Role/SecurityGroup updates are refused. AWS administrators can override these controls; this cannot guarantee security elsewhere in the account.

Data, secrets, IP, DNS and backups remain, with continuing retained-service costs. AWS pause does not stop local Docker, revoke independent credentials or erase already shared data. Do not delete stacks/volumes to pause; teardown needs deliberate backup/cost review.

For code-only updates, check out compatible platform/template revisions, run tests, then:

```bash
node scripts/release-aws.mjs
```

Deploy/release refuse disabled projects. Never enable just to edit docs or push source. Releases rebuild both images without replacing EC2 or changing secret values. Infrastructure changes require a reviewed change set: UserData updates do not rerun cloud-init, latest-AMI parameters can imply replacement, and project/domain changes are not safe renames. The narrow `update-inventory-policy` helper refuses non-IAM changes; old stacks missing new parameters need manual migration.

Back up the entire data volume (SQLite, worktrees and local bare Git), not just source. Daily EBS snapshots are crash-consistent; test restore in isolation. Preserve private deployment state/cookie secrets. Rollback uses previously tested source revisions; do not blindly roll back database migrations.

## AI providers

**Bedrock on AWS:** CloudFormation provisions role permissions and the AI config secret. Changing models requires both exact invoke permissions and the model field. `DEPLOY_BEDROCK_MODEL=... node scripts/upgrade-ai.mjs` makes a billable operator-identity preflight and updates only the field; separately verify application-role permissions.

**Vertex locally:** use your own billed GCP project, enabled Vertex API and permissions for Vertex AI/project service consumption:

```bash
gcloud auth login
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_GCP_PROJECT
gcloud services enable aiplatform.googleapis.com --project YOUR_GCP_PROJECT
```

Set `.env`: `AI_PROVIDER=vertex`, `GOOGLE_CLOUD_PROJECT=YOUR_GCP_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, `VERTEX_MODEL=YOUR_AVAILABLE_MODEL`. `npm run vertex:check` makes a billable verification request. For Docker set `ADC_FILE` to your local ADC file and use `docker compose -f compose.yaml -f compose.adc.yaml up -d platform`. Never commit/send ADC.

**Vertex on AWS:** the AI secret supports `{"provider":"vertex","project":"YOUR_GCP_PROJECT","location":"global","model":"YOUR_MODEL","credentials":{"client_email":"SERVICE_ACCOUNT_EMAIL","private_key":"PRIVATE_KEY"}}`. Enter real credentials only through Secrets Manager. Long-lived service-account keys need rotation; developer ADC is not a production identity. Workload-identity federation needs additional integration and is not automatically provisioned. The deployment helper initially requires Bedrock configuration; review/remove invoke permissions when permanently switching providers.

Local environment providers also include OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`) and Copilot (`COPILOT_GITHUB_TOKEN`, `COPILOT_MODEL`), subject to provider access/entitlements. The Secrets Manager AI schema covers Bedrock/Vertex only. No original author's subscription or credentials are included.

## Capabilities and security boundaries

Explicit typed AWS operations cover CloudFormation resource grouping, EC2/EBS/networking, CloudWatch metrics/logs/alarms, CloudTrail, RDS, Lambda, DynamoDB metadata, ECS/EKS, S3 bucket inventory, IAM metadata, Route53, CloudFront, API Gateway, SQS/SNS, Step Functions, ECR, ElastiCache, secret metadata, KMS and Backup. See `server/aws-operations.ts`. Queries are bounded, cached where appropriate and disclose truncation/errors; partial results are not a full account audit.

The chat can answer without editing or publish validated charts, tables, log controls and notes. Complex widgets use draft → test → publish with untrusted JavaScript stored as inert JSON. QuickJS/WASM exposes no DOM, Node, network, cloud credentials or package loader. Backend tests use disposable resource-limited Docker containers; browsers use workers and bounded JSON rendering. Primitives include cards, bars, tables, buttons and a 3D box scene with keyboard flight—not arbitrary React/npm/browser access. Interpreter/browser vulnerabilities remain possible.

EBS provisioned capacity is not used disk space. CPU is a sampled average, not instantaneous load. Guest disk/memory usage requires telemetry not currently provided. Logs must exist in CloudWatch. Sharing a widget intentionally gives its bound data to the revocable link holder.

Dashboard/chat scroll independently. Delete moves a session to recoverable Trash, stops its runtime and revokes sharing; secure purge is not implemented. Passwords, rate limits and daily prompt limits protect the workspace. The model has no unrestricted AWS SDK or shell tool. Generated sessions receive no cloud keys, Docker socket, public ports or internet route. Never expose their Next.js devservers directly.

## Git and session portability

Template `main` is empty. Sessions use `session/<24-character-id>`. Accepted edits update `dashboard.json` and generated source, type-check, commit and push. Failed validation restores prior source; failed push offers retry. History restore makes a new commit.

Default remote: private local bare Git under the data directory (`/data/dashboard.git` in Docker). **Publishing the source repositories does not publish production sessions/chats.** A session URL on another computer reaches the same backend. A fresh backend can import remote session branches, but chat/audit/sharing requires SQLite backup.

Optional `DASHBOARD_REPO_URL` connects a private write-enabled remote. Provision scoped Git authentication inside the trusted platform separately; never put tokens in URLs or credentials in sessions. Specs/custom source/messages can contain sensitive identifiers/text. Never push `--all` or `--mirror` from production data into a public template repository.

## Development and publication checklist

```bash
npm run check
npm test
npm run check --prefix dashboard-base
# Optional local browser suite; install Playwright Chromium first:
npm run test:e2e
```

Live smoke scripts create/edit sessions, query real data and spend model tokens. Do not run them for documentation/publication. Optional test settings include `CHECK_SESSION_ID`, `CHECK_INSTANCE_ID`, `CHECK_MODEL`, `CHECK_LOG_GROUP`, `CHECK_HOSTED_ZONE_ID`; use your own resources. Unit tests use synthetic fixtures.

Before publishing, scan staged/tracked source **and complete Git history** with a secret scanner such as Gitleaks and `--redact`, plus manual review. Scans cannot prove absence of all secrets. Environments, data, DNS exports, cloud credentials, screenshots, presentation assets and builds are excluded. Revoke/rotate any real detected secret; merely deleting its latest copy is insufficient.

For AI maintainers: inspect both repositories; preserve user changes; never print secrets; verify target identity before AWS mutations; never enable a paused deployment without explicit approval; test locally before releasing; do not implicitly broaden connector access or publish session branches. Trusted widget contracts need compatible changes in both repositories. Rebuild the pinned interpreter with `npm run build:custom` and rebuild both container images after runtime changes.
