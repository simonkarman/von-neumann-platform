export function expectedAccount(state) {
  const roleAccount = state.InstanceRoleArn?.split(":")[4];
  if (state.AccountId && roleAccount && state.AccountId !== roleAccount)
    throw new Error("Deployment account and role ARN disagree");
  const account = state.AccountId || roleAccount;
  if (!/^\d{12}$/.test(account || ""))
    throw new Error("Deployment state needs AccountId or an instance-role ARN");
  return account;
}

export function deploymentConfig(env = process.env) {
  const account = env.DEPLOY_ACCOUNT_ID;
  const domain = env.DEPLOY_DOMAIN;
  const project = env.DEPLOY_PROJECT_NAME || "von-neumann";
  const model = env.DEPLOY_BEDROCK_MODEL;
  const region = env.DEPLOY_REGION || env.AWS_REGION || "eu-west-1";
  if (!/^\d{12}$/.test(account || ""))
    throw new Error("Set DEPLOY_ACCOUNT_ID to your 12-digit target account");
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain || "") ||
    domain.endsWith(".example.com")
  )
    throw new Error("Set DEPLOY_DOMAIN to a real subdomain you control");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(project))
    throw new Error("Invalid DEPLOY_PROJECT_NAME");
  if (!model || !/^[a-zA-Z0-9.:-]+$/.test(model))
    throw new Error(
      "Set DEPLOY_BEDROCK_MODEL to an accessible Bedrock model/profile ID",
    );
  const regions = (env.DEPLOY_INVENTORY_REGIONS || region).split(",");
  if (![region, ...regions].every((r) => /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(r)))
    throw new Error("Invalid deployment/inventory region");
  return {
    account,
    domain,
    project,
    model,
    region,
    regions,
    profile: env.DEPLOY_PROFILE || env.AWS_PROFILE || "default",
    foundationStack: `${project}-foundation`,
    applicationStack: `${project}-application`,
  };
}
