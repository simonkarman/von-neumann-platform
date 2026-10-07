import test from "node:test";
import assert from "node:assert/strict";
import { connectorSecretSchema } from "../server/secrets.js";
test("connector secret validates credentials without altering platform identity", () => {
  const before = process.env.AWS_ACCESS_KEY_ID;
  assert.equal(
    connectorSecretSchema.parse({ auth: "iam", region: "eu-west-1" }).instances
      .length,
    0,
  );
  assert.throws(() =>
    connectorSecretSchema.parse({ auth: "assume_role", region: "eu-west-1" }),
  );
  assert.throws(() =>
    connectorSecretSchema.parse({
      auth: "access_keys",
      region: "eu-west-1",
      accessKeyId: "example",
    }),
  );
  assert.throws(() =>
    connectorSecretSchema.parse({
      auth: "iam",
      region: "eu-west-1",
      unexpected: true,
    }),
  );
  assert.equal(process.env.AWS_ACCESS_KEY_ID, before);
});
