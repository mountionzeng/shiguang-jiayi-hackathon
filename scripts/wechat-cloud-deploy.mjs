import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const FAILURE_MARKERS = ["ResourceNotFound", "[error]", "Error", "✖"];

export function parseArgs(argv) {
  const parsed = { execute: false, env: null, project: null, includes: [] };
  const seenSingletons = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      if (seenSingletons.has(argument)) throw new Error("Duplicate option is not allowed.");
      seenSingletons.add(argument);
      parsed.execute = true;
      continue;
    }

    if (argument === "--env" || argument === "--project" || argument === "--include") {
      if (argument !== "--include" && seenSingletons.has(argument)) {
        throw new Error("Duplicate option is not allowed.");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("An option value is missing.");
      index += 1;
      if (argument === "--include") {
        if (parsed.includes.includes(value)) throw new Error("Duplicate function inclusion is not allowed.");
        parsed.includes.push(value);
      } else {
        seenSingletons.add(argument);
        parsed[argument === "--env" ? "env" : "project"] = value;
      }
      continue;
    }

    // Keep this deliberately generic: a mistyped argument may contain a credential.
    throw new Error("Unknown option. Supported options are --execute, --env, --project, and --include.");
  }

  if (!parsed.execute && parsed.env !== null) throw new Error("--env is only valid with --execute.");
  if (parsed.execute && !parsed.env) throw new Error("--execute requires --env.");
  return parsed;
}

export function planDeployment(manifest, includes = []) {
  if (!manifest || typeof manifest.cloudFunctions !== "object") {
    throw new Error("Invalid WeChat cloud deployment manifest.");
  }

  const entries = manifest.cloudFunctions;
  const defaults = Object.entries(entries)
    .filter(([, entry]) => entry.defaultDeploy === true)
    .map(([name]) => name);

  for (const name of includes) {
    const entry = entries[name];
    if (!entry) throw new Error("Requested cloud function is not registered in the deployment manifest.");
    if (entry.deploymentClass === "dangerousMaintenance") {
      throw new Error("Dangerous maintenance functions require the separate manual workflow.");
    }
    if (entry.defaultDeploy === true) throw new Error("Default cloud functions must not be included explicitly.");
    if (!["configured", "bootstrapOnce", "diagnosticOnly", "migrationOnly"].includes(entry.deploymentClass)) {
      throw new Error("Requested cloud function has an unsupported deployment class.");
    }
  }

  return [...defaults, ...includes];
}

function defaultRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function assertCommandSucceeded(result, expectedName = null) {
  const output = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  if (result?.exitCode !== 0 || FAILURE_MARKERS.some((marker) => output.includes(marker))) {
    throw new Error("WeChat DevTools CLI reported a failure; output was withheld.");
  }
  if (expectedName && (!output.includes(expectedName) || !output.includes("Active"))) {
    throw new Error("Cloud function verification did not confirm the requested function as Active.");
  }
}

export async function run(argv = process.argv.slice(2), options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const parsed = parseArgs(argv);
  const manifestPath = path.join(rootDir, "deploy/wechat-cloud.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const names = planDeployment(manifest, parsed.includes);
  const project = path.resolve(parsed.project ?? rootDir);
  const stdout = options.stdout ?? process.stdout;

  if (!parsed.execute) {
    const result = { mode: "preview", count: names.length, names };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const runner = options.runner ?? defaultRunner;
  const cliPath = options.cliPath ?? "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
  const deployArgs = [
    "cloud", "functions", "deploy",
    "--env", parsed.env,
    "--project", project,
    "--remote-npm-install",
    "--names", ...names,
  ];
  assertCommandSucceeded(await runner(cliPath, deployArgs, { cwd: rootDir }));

  for (const name of names) {
    const infoArgs = ["cloud", "functions", "info", "--env", parsed.env, "--project", project, "--names", name];
    assertCommandSucceeded(await runner(cliPath, infoArgs, { cwd: rootDir }), name);
  }

  const result = { mode: "execute", count: names.length, names, verified: names };
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
