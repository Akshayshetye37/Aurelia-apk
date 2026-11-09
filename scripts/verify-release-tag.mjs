import { pathToFileURL } from "node:url";

export const REQUIRED_RELEASE_CHECKS = Object.freeze(["r1-governance", "native-security-kotlin"]);

export function evaluateRequiredChecks(checkRuns, requiredNames = REQUIRED_RELEASE_CHECKS) {
  const failures = [];
  for (const name of requiredNames) {
    const matching = (Array.isArray(checkRuns) ? checkRuns : []).filter(run => run.name === name);
    if (!matching.length) {
      failures.push({ name, reason: "missing" });
      continue;
    }
    const latest = matching.sort((a, b) => String(b.completed_at || b.started_at || "").localeCompare(String(a.completed_at || a.started_at || "")))[0];
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      failures.push({ name, reason: latest.status === "completed" ? (latest.conclusion || "no conclusion") : (latest.status || "not completed") });
    }
  }
  return { ok: failures.length === 0, failures };
}

export async function verifyTaggedSha({ repository, sha, token, fetchImpl = fetch }) {
  if (!repository || !/^[0-9a-f]{40}$/i.test(String(sha || "")) || !token) {
    throw new Error("Repository, full 40-character tag SHA, and GitHub token are required.");
  }
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`Unable to verify checks for tagged SHA (${response.status}). Refusing release tag.`);
  const payload = await response.json();
  const result = evaluateRequiredChecks(payload.check_runs);
  if (!result.ok) {
    throw new Error("Release tag refused. Required checks are not all green: " + result.failures.map(x => x.name + "=" + x.reason).join(", "));
  }
  return { ok: true, sha, requiredChecks: REQUIRED_RELEASE_CHECKS };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyTaggedSha({
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN
    });
    process.stdout.write(`Release tag accepted for verified SHA ${result.sha}.\n`);
  } catch (error) {
    process.stderr.write(String(error.message || error) + "\n");
    process.exitCode = 1;
  }
}
