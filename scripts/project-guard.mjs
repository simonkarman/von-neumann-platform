import { execFileSync } from "node:child_process";
// Prevent the usual deployment scripts from silently undoing the kill switch.
export function assertProjectEnabled({
  profile,
  region,
  allowMissing = false,
  ApplicationStack = "von-neumann-application",
}) {
  let result;
  try {
    result = JSON.parse(
      execFileSync(
        "aws",
        [
          "cloudformation",
          "describe-stacks",
          "--stack-name",
          ApplicationStack,
          "--profile",
          profile,
          "--region",
          region,
          "--output",
          "json",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      ),
    );
  } catch (error) {
    if (
      allowMissing &&
      String(error.stderr).includes(
        `Stack with id ${ApplicationStack} does not exist`,
      )
    )
      return;
    throw error;
  }
  if (
    result.Stacks[0].Parameters.some(
      (p) =>
        p.ParameterKey === "ProjectEnabled" && p.ParameterValue === "false",
    )
  )
    throw new Error(
      "Project is disabled. Deployment refused. Run npm run project:enable explicitly before deploying.",
    );
}
