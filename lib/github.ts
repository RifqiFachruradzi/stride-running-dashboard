// Commits updated data files back to the dashboard's own GitHub repo so the
// JSON in /data stays the single source of truth and version history.
//
// IMPORTANT: this uses a GitHub Personal Access Token stored as a Vercel env
// var (GITHUB_TOKEN) — this is a *separate* credential from "Claude connected
// to GitHub" in the chat UI. That connector lets Claude push code from this
// session; it has no bearing on what the deployed app can do at runtime. The
// deployed cron job needs its own token because it runs independently, long
// after this conversation ends.
//
// Recommended: a fine-grained PAT scoped to just this repo, "Contents:
// Read and write" permission only.

import { Octokit } from "@octokit/rest";

const owner = process.env.GITHUB_OWNER!;
const repo = process.env.GITHUB_REPO!;
const branch = process.env.GITHUB_BRANCH || "main";

function client() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN env var is not set on the Vercel project.");
  }
  return new Octokit({ auth: token });
}

export interface FileToCommit {
  path: string; // e.g. "data/runs.json"
  content: string; // raw file content (will be base64-encoded)
}

/**
 * Writes the files that changed in a single commit (so one sync triggers one
 * redeploy, not one per file). Returns false (no-op) if nothing changed.
 */
export async function commitDataFiles(
  files: FileToCommit[],
  message: string
): Promise<boolean> {
  const octokit = client();
  const target = `${owner}/${repo}@${branch}`;
  const fail = (step: string, err: any) =>
    new Error(
      `${step} ${target} gagal (${err.status ?? "?"}): ${err.message}. ` +
        "Cek GITHUB_OWNER/GITHUB_REPO/GITHUB_BRANCH dan akses GITHUB_TOKEN ke repo ini (Contents: Read and write)."
    );

  let baseSha: string;
  let baseTree: string;
  try {
    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    baseSha = ref.object.sha;
    const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });
    baseTree = commit.tree.sha;
  } catch (err: any) {
    // GitHub answers 404 (not 403) when the token can't see a private repo.
    throw fail("Membaca", err);
  }

  const changed: FileToCommit[] = [];
  for (const file of files) {
    const encoded = Buffer.from(file.content, "utf-8").toString("base64");
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path: file.path, ref: baseSha });
      if (!Array.isArray(data) && data.type === "file" && data.content?.replace(/\n/g, "") === encoded) {
        continue; // no change
      }
    } catch (err: any) {
      if (err.status !== 404) throw fail(`Membaca ${file.path} di`, err);
      // File doesn't exist yet — will be created.
    }
    changed.push(file);
  }
  if (changed.length === 0) return false;

  try {
    const { data: tree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTree,
      tree: changed.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content })),
    });
    const { data: commit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: [baseSha],
    });
    // Not forced: if the branch moved meanwhile this fails instead of
    // dropping someone else's commit.
    await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });
  } catch (err: any) {
    throw fail("Commit ke", err);
  }
  return true;
}

/** For /api/health: can the token see the repo and branch, and may it push? */
export async function checkGitHubAccess(): Promise<{
  target: string;
  ok: boolean;
  canPush?: boolean;
  error?: string;
}> {
  const target = `${owner}/${repo}@${branch}`;
  try {
    const octokit = client();
    const { data } = await octokit.repos.get({ owner, repo });
    await octokit.repos.getBranch({ owner, repo, branch });
    return { target, ok: true, canPush: data.permissions?.push };
  } catch (err: any) {
    return {
      target,
      ok: false,
      error:
        err.status === 404
          ? "Repo atau branch tidak ditemukan — nama salah, atau GITHUB_TOKEN tidak punya akses ke repo ini."
          : err.status === 401
          ? "GITHUB_TOKEN tidak valid atau sudah kedaluwarsa."
          : err.message,
    };
  }
}
