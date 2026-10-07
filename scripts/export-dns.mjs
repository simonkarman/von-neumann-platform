// Creates a private BIND import file from this deployment, never from a checked-in zone.
import { readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(".data/aws-deployment.json", "utf8"));
const domain = state.Domain || new URL(state.Url).hostname;
const parent = process.env.DNS_PARENT_ZONE;
if (!parent || !/^[a-z0-9.-]+$/.test(parent) || !domain.endsWith(`.${parent}`))
  throw new Error(
    "Set DNS_PARENT_ZONE to the existing parent zone of the dashboard subdomain",
  );
const names = state.NameServers.split(",");
if (!names.length || names.some((n) => !/^[a-z0-9.-]+$/.test(n)))
  throw new Error("Invalid nameservers in deployment state");
writeFileSync(
  ".data/dns-delegation.bind",
  `$ORIGIN ${parent}.\n$TTL 300\n${names.map((n) => `${domain}. IN NS ${n.replace(/\.$/, "")}.`).join("\n")}\n`,
  { mode: 0o600 },
);
console.log(
  "Import .data/dns-delegation.bind into your EXISTING parent DNS zone; do not change registrar nameservers.",
);
