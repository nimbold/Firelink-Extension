const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyReleaseRef } = require("../scripts/verify-release-ref.js");

const validRelease = {
  refType: "tag",
  refName: "v2.2.2",
  githubSha: "abc123",
  tagCommitSha: "abc123",
  packageVersion: "2.2.2",
  manifestVersion: "2.2.2",
};

test("accepts the exact stable version tag at the checked out commit", () => {
  assert.deepEqual(verifyReleaseRef(validRelease), { tagName: "v2.2.2", version: "2.2.2" });
});

test("rejects manual dispatches from branches before release publication", () => {
  assert.throws(
    () => verifyReleaseRef({ ...validRelease, refType: "branch", refName: "main" }),
    /must run from a version tag/
  );
});

test("rejects a tag whose version differs from package metadata", () => {
  assert.throws(
    () => verifyReleaseRef({ ...validRelease, refName: "v2.2.3" }),
    /does not match extension package version/
  );
});

test("rejects package and manifest version drift", () => {
  assert.throws(
    () => verifyReleaseRef({ ...validRelease, manifestVersion: "2.2.1" }),
    /Extension versions do not agree/
  );
});

test("rejects a tag ref that does not resolve to the checked out commit", () => {
  assert.throws(
    () => verifyReleaseRef({ ...validRelease, tagCommitSha: "def456" }),
    /does not resolve to the workflow commit/
  );
});

test("rejects non-stable and malformed release tags", () => {
  for (const refName of ["v2.2.2-rc.1", "v02.2.2", "2.2.2", "v2.2"]) {
    assert.throws(() => verifyReleaseRef({ ...validRelease, refName }), /not a stable/);
  }
});
