// Explicit operator action; preserve existing authentication and never print secrets.
import { readFileSync } from "node:fs";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const { regions: discoveredRegions, account } = JSON.parse(
  readFileSync(".data/aws-inventory.json", "utf8"),
);
const expected = state.AccountId || state.InstanceRoleArn?.split(":")[4];
if (account !== expected)
  throw new Error("Discovery belongs to a different AWS account");
const regions = process.env.DEPLOY_INVENTORY_REGIONS?.split(",") || [
  state.region,
];
if (regions.some((r) => !discoveredRegions.includes(r)))
  throw new Error("Requested region not in the discovery report");
const client = new SecretsManagerClient({
  region: state.region,
  credentials: fromIni({ profile: state.profile }),
});
try {
  const old = await client.send(
    new GetSecretValueCommand({ SecretId: state.ConnectorSecretArn }),
  );
  const value = {
    ...JSON.parse(old.SecretString),
    inventoryEnabled: true,
    regions,
    allowLogReads: true,
    allowTableReads: false,
  };
  await client.send(
    new PutSecretValueCommand({
      SecretId: state.ConnectorSecretArn,
      SecretString: JSON.stringify(value),
    }),
  );
  console.log(
    `Enabled account-wide inventory, metrics and log reads in ${regions.length} regions. Authentication and table-record restrictions preserved.`,
  );
} finally {
  client.destroy();
}
