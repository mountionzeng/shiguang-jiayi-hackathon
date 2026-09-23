const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "deploy/wechat-cloud.manifest.json"), "utf8"));
const functionRoot = path.join(root, "cloudfunctions");
const { CORE_COLLECTIONS } = require("../cloudfunctions/ensureCloudCollections/bootstrap.js");

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

test("cloud deployment manifest classifies every cloud function directory", () => {
  const directories = fs.readdirSync(functionRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(functionRoot, entry.name, "index.js")))
    .map(entry => entry.name);

  assert.deepEqual(sorted(Object.keys(manifest.cloudFunctions)), sorted(directories));

  const allowedClasses = new Set(Object.keys(manifest.deploymentClasses));
  for (const [name, config] of Object.entries(manifest.cloudFunctions)) {
    assert.ok(allowedClasses.has(config.deploymentClass), `${name} has an unknown deployment class`);
    assert.equal(typeof config.defaultDeploy, "boolean", `${name} must explicitly declare defaultDeploy`);
    assert.equal(config.defaultDeploy, config.deploymentClass === "base", `${name} must only deploy by default when it is a base function`);
    assert.ok(Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds > 0, `${name} must declare a positive integer timeoutSeconds`);
    assert.ok(Array.isArray(config.environmentVariables), `${name} must list environment variable names, even when empty`);
  }
});

test("literal client cloud function calls are present and production-classified", () => {
  const serviceRoot = path.join(root, "miniprogram");
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:js|ts)$/.test(entry.name)) files.push(target);
    }
  };
  visit(serviceRoot);

  const called = new Set();
  const callPattern = /wx\.cloud\.callFunction\s*\(\s*\{[\s\S]*?\bname\s*:\s*["']([^"']+)["']/g;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(callPattern)) called.add(match[1]);
  }

  assert.ok(called.size > 0, "expected to discover literal client cloud function calls");
  for (const name of called) {
    const config = manifest.cloudFunctions[name];
    assert.ok(config, `${name} is called by the client but absent from the deployment manifest`);
    assert.ok(["base", "configured"].includes(config.deploymentClass), `${name} is client-called but marked ${config.deploymentClass}`);
  }
});

test("operator and dangerous functions cannot be selected for default deployment", () => {
  for (const name of ["ensureCloudCollections", "inspectFamilyData", "userDataMigration", "deleteDemoFamilyOnce"]) {
    assert.equal(manifest.cloudFunctions[name].defaultDeploy, false);
  }
  assert.equal(manifest.cloudFunctions.ensureCloudCollections.deploymentClass, "bootstrapOnce");
  assert.equal(manifest.cloudFunctions.inspectFamilyData.deploymentClass, "diagnosticOnly");
  assert.equal(manifest.cloudFunctions.userDataMigration.deploymentClass, "migrationOnly");
  assert.equal(manifest.cloudFunctions.deleteDemoFamilyOnce.deploymentClass, "dangerousMaintenance");
});

test("bootstrap collections and deployment manifest cannot drift", () => {
  assert.deepEqual(sorted(Object.keys(manifest.collections)), sorted(CORE_COLLECTIONS));
  for (const [name, indexes] of Object.entries(manifest.collections)) {
    assert.ok(Array.isArray(indexes), `${name} must explicitly list indexes, even when it needs none`);
  }
});

test("cloud room deletion queries have their required compound indexes", () => {
  for (const name of ["family_members", "source_records", "memories"]) {
    assert.ok(
      manifest.collections[name].some(index => index.endsWith("familyId, _id")),
      `${name} must index familyId followed by _id`,
    );
  }
});
