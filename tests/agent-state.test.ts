import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "vn-agent-state-"));
process.env.AI_PROVIDER = "bedrock";
process.env.RUNTIME_DRIVER = "process";
process.env.DASHBOARD_REPO_URL = "";
process.env.DASHBOARD_TEMPLATE_DIR = path.resolve("dashboard-base");
const { store } = await import("../server/store.js");
const { prepareWorkspace } = await import("../server/git.js");
const { connectors } = await import("../server/connectors.js");
const { runAgent } = await import("../server/agent.js");
test("Bedrock cannot finish a named CPU-graph request by repeating a stale completion claim", async () => {
  const session = store.create();
  const dir = await prepareWorkspace(session.id);
  await symlink(
    path.resolve("dashboard-base/node_modules"),
    path.join(dir, "node_modules"),
    "dir",
  );
  const oldConnector = connectors.get("aws")!;
  connectors.set("aws", {
    id: "aws",
    describe: () => ({}),
    validate: () => {},
    query: async () => ({}),
  });
  const original = BedrockRuntimeClient.prototype.send;
  let calls = 0;
  let systemPrompt: string | undefined;
  BedrockRuntimeClient.prototype.send = (async (command: any) => {
    calls++;
    systemPrompt ??= command.input.system[0].text;
    assert.equal(command.input.system[0].text, systemPrompt, 'system prefix must remain stable after tool mutations for signed reasoning blocks');
    assert.match(
      command.input.system[0].text,
      /AUTHORITATIVE CURRENT SAVED DASHBOARD/,
    );
    if (calls === 1)
      return {
        output: {
          message: {
            role: "assistant",
            content: [
              { text: "Incorrect stale claim: I already added your graph." },
            ],
          },
        },
        stopReason: "end_turn",
      };
    if (calls === 2) {
      assert.match(
        JSON.stringify(command.input.messages),
        /Runtime validation rejected completion/,
      );
      return {
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "fix",
                  name: "update_dashboard",
                  input: {
                    specification: {
                      title: "CPU",
                      widgets: [
                        {
                          id: "cpu",
                          title: "CPU",
                          type: "chart",
                          query: {
                            operation: "cpu",
                            instanceId: "i-00000000000000002",
                            region: "eu-west-1",
                            hours: 24,
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
      };
    }
    return {
      output: {
        message: {
          role: "assistant",
          content: [{ text: "The CPU chart is now saved." }],
        },
      },
      stopReason: "end_turn",
    };
  }) as any;
  try {
    const events: any[] = [];
    await runAgent(
      session.id,
      "Add a CPU graph for i-00000000000000002",
      (e) => events.push(e),
      new AbortController().signal,
    );
    assert.equal(calls, 3);
    assert.ok(events.some((e) => e.type === "updated"));
    assert.ok(!events.some((e) => e.type === "error"));
    assert.ok(!JSON.stringify(events).includes("Incorrect stale claim"));
    assert.equal(store.get(session.id)!.dashboard.widgets[0].type, "chart");
  } finally {
    BedrockRuntimeClient.prototype.send = original;
    connectors.set("aws", oldConnector);
  }
});
