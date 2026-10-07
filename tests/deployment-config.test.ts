import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error operational scripts are native JavaScript
import {
  deploymentConfig,
  expectedAccount,
} from "../scripts/deployment-config.mjs";
test("deployment requires explicit account, domain and model", () => {
  assert.throws(() => deploymentConfig({}), /DEPLOY_ACCOUNT_ID/);
  const env = {
    DEPLOY_ACCOUNT_ID: "111122223333",
    DEPLOY_DOMAIN: "dashboard.example.org",
    DEPLOY_BEDROCK_MODEL: "us.test-model-v1:0",
    AWS_PROFILE: "operator",
    DEPLOY_REGION: "us-east-1",
    DEPLOY_PROJECT_NAME: "research",
  };
  const c = deploymentConfig(env);
  assert.equal(c.applicationStack, "research-application");
  assert.equal(c.profile, "operator");
  assert.deepEqual(c.regions, ["us-east-1"]);
  assert.throws(
    () => deploymentConfig({ ...env, DEPLOY_DOMAIN: "bad'; echo nope" }),
    /DEPLOY_DOMAIN/,
  );
  assert.throws(
    () => deploymentConfig({ ...env, DEPLOY_PROJECT_NAME: "../bad" }),
    /PROJECT_NAME/,
  );
  assert.throws(
    () => deploymentConfig({ ...env, DEPLOY_BEDROCK_MODEL: "" }),
    /BEDROCK_MODEL/,
  );
});
test("account checks preserve compatibility without hardcoded account IDs", () => {
  assert.equal(
    expectedAccount({
      InstanceRoleArn: "arn:aws:iam::111122223333:role/project",
    }),
    "111122223333",
  );
  assert.equal(expectedAccount({ AccountId: "444455556666" }), "444455556666");
  assert.throws(() => expectedAccount({}), /AccountId/);
  assert.throws(
    () =>
      expectedAccount({
        AccountId: "444455556666",
        InstanceRoleArn: "arn:aws:iam::111122223333:role/project",
      }),
    /disagree/,
  );
});
