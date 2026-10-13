const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function verifyReleaseRef({
  refType,
  refName,
  githubSha,
  tagCommitSha,
  packageVersion,
  manifestVersion,
}) {
  if (refType !== "tag") {
    throw new Error("Extension releases must run from a version tag, not a branch.");
  }

  const match = typeof refName === "string" && /^v(.+)$/.exec(refName);
  if (!match || !STABLE_VERSION.test(match[1])) {
    throw new Error(`Release ref ${String(refName)} is not a stable vMAJOR.MINOR.PATCH tag.`);
  }
  const tagVersion = match[1];

  if (!packageVersion || packageVersion !== manifestVersion) {
    throw new Error(
      `Extension versions do not agree: package.json=${packageVersion || "missing"}, ` +
        `manifest.json=${manifestVersion || "missing"}.`
    );
  }
  if (tagVersion !== packageVersion) {
    throw new Error(
      `Release tag ${refName} does not match extension package version ${packageVersion}.`
    );
  }
  if (!githubSha || !tagCommitSha || githubSha.toLowerCase() !== tagCommitSha.toLowerCase()) {
    throw new Error(`Release tag ${refName} does not resolve to the workflow commit.`);
  }

  return { tagName: refName, version: tagVersion };
}

function verifyCurrentReleaseRef(env = process.env) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (env.GITHUB_REF_TYPE !== "tag") {
    throw new Error("Extension releases must run from a version tag, not a branch.");
  }

  const tagCommitSha = execFileSync(
    "git",
    ["rev-parse", `refs/tags/${env.GITHUB_REF_NAME}^{commit}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
  return verifyReleaseRef({
    refType: env.GITHUB_REF_TYPE,
    refName: env.GITHUB_REF_NAME,
    githubSha: env.GITHUB_SHA,
    tagCommitSha,
    packageVersion: packageJson.version,
    manifestVersion: manifest.version,
  });
}

if (require.main === module) {
  try {
    const { tagName, version } = verifyCurrentReleaseRef();
    console.log(`Extension release ${version} is verified at ${tagName}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { verifyReleaseRef };
