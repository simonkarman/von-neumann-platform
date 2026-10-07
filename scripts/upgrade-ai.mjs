// Update only the model field, preserving the existing secret; never print values.
import { readFile } from "node:fs/promises";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
const state = JSON.parse(await readFile(".data/aws-deployment.json", "utf8"));
const options = {
  region: state.region,
  credentials: fromIni({ profile: state.profile }),
};
const secrets = new SecretsManagerClient(options),
  bedrock = new BedrockRuntimeClient(options);
const model = process.env.DEPLOY_BEDROCK_MODEL;
if (!model)
  throw new Error(
    "Set DEPLOY_BEDROCK_MODEL; first update the application role invoke resources for that model",
  );
try {
  await bedrock.send(
    new ConverseCommand({
      modelId: model,
      messages: [{ role: "user", content: [{ text: "Reply OK." }] }],
      inferenceConfig: { maxTokens: 512 },
    }),
  );
  const old = await secrets.send(
    new GetSecretValueCommand({ SecretId: state.AiSecretArn }),
  );
  const config = JSON.parse(old.SecretString);
  if (config.provider !== "bedrock")
    throw new Error("Refusing to replace a different AI provider");
  if (config.model === model)
    console.log("AI secret already selects the requested model.");
  else {
    config.model = model;
    await secrets.send(
      new PutSecretValueCommand({
        SecretId: state.AiSecretArn,
        SecretString: JSON.stringify(config),
      }),
    );
    console.log(
      `AI secret updated. Previous secret version retained for rollback: ${old.VersionId}`,
    );
  }
} finally {
  secrets.destroy();
  bedrock.destroy();
}
