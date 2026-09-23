import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, planDeployment, run } from "../scripts/wechat-cloud-deploy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "deploy/wechat-cloud.manifest.json"), "utf8"));

test("default plan contains exactly defaultDeploy functions", () => {
  const expected = Object.entries(manifest.cloudFunctions)
    .filter(([, entry]) => entry.defaultDeploy === true)
    .map(([name]) => name);
  const plan = planDeployment(manifest);
  assert.deepEqual(plan, expected);
  for (const excluded of ["ensureCloudCollections", "inspectFamilyData", "userDataMigration", "deleteDemoFamilyOnce", "storyImages"] ) {
    assert.equal(plan.includes(excluded), false);
  }
  assert.ok(plan.every((name) => manifest.cloudFunctions[name].deploymentClass === "base"));
});

test("explicit configured inclusion works", () => {
  assert.ok(planDeployment(manifest, ["storyImages"]).includes("storyImages"));
  assert.ok(planDeployment(manifest, ["userDataMigration"]).includes("userDataMigration"));
});

test("dangerous maintenance inclusion is always refused", () => {
  assert.throws(() => planDeployment(manifest, ["deleteDemoFamilyOnce"]), /separate manual workflow/);
});

test("arguments fail closed on unknown, duplicate, and missing values", () => {
  assert.throws(() => parseArgs(["--mystery", "sensitive-value"]), /Unknown option/);
  assert.throws(() => parseArgs(["--include", "storyImages", "--include", "storyImages"]), /Duplicate/);
  assert.throws(() => parseArgs(["--execute", "--env"]), /missing/);
  assert.throws(() => parseArgs(["--execute"]), /requires --env/);
});

test("execute deploys explicit names and verifies every function as Active", async () => {
  const calls = [];
  let output = "";
  const runner = async (command, args) => {
    calls.push({ command, args });
    const isInfo = args[2] === "info";
    const nameIndex = args.indexOf("--names");
    return !isInfo
      ? { exitCode: 0, stdout: "deployment accepted", stderr: "" }
      : { exitCode: 0, stdout: `${args[nameIndex + 1]} Active`, stderr: "" };
  };

  const result = await run(["--execute", "--env", "test-env", "--include", "storyImages"], {
    rootDir: root,
    cliPath: "/test/cli",
    runner,
    stdout: { write: (chunk) => { output += chunk; } },
  });

  assert.equal(calls[0].command, "/test/cli");
  assert.deepEqual(calls[0].args.slice(0, 3), ["cloud", "functions", "deploy"]);
  assert.ok(calls[0].args.includes("--names"));
  assert.equal(calls[0].args.includes("--all"), false);
  assert.ok(calls[0].args.includes("--remote-npm-install"));
  const deployedNames = calls[0].args.slice(calls[0].args.indexOf("--names") + 1);
  assert.deepEqual(deployedNames, result.names);
  assert.equal(calls.length, result.names.length + 1);
  assert.match(output, /"verified"/);
});

test("false-success CLI output is rejected even with exit code zero", async () => {
  await assert.rejects(
    run(["--execute", "--env", "test-env"], {
      rootDir: root,
      cliPath: "/test/cli",
      runner: async () => ({ exitCode: 0, stdout: "ResourceNotFound", stderr: "" }),
      stdout: { write() {} },
    }),
    /reported a failure/,
  );
});

test("preview emits structured JSON", async () => {
  let output = "";
  const result = await run([], { rootDir: root, stdout: { write: (chunk) => { output += chunk; } } });
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(result.mode, "preview");
});
