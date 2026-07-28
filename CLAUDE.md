# Notes for Claude Code sessions on this repo

## Stop-hook: "Unverified" merge commit right after merging a PR

`~/.claude/stop-hook-git-check.sh` flags any commit whose committer email isn't `noreply@anthropic.com` as one GitHub will show "Unverified." After merging a PR via the GitHub MCP tool (`mcp__github__merge_pull_request`, or any GitHub-side merge/squash/rebase-merge), the resulting merge commit's committer is `GitHub <noreply@github.com>` — that's just how GitHub stamps any commit its own API/UI creates, not something local `git config` controls or a sign that anything went wrong.

Its `%G?` status commonly comes back `E` (a signature *is* present but can't be verified locally — most likely because GitHub signed it with GitHub's own key, which isn't imported in this environment), not `N` (no signature at all). That's strong evidence GitHub's own web UI already shows the commit "Verified" — this hook's local heuristic is a false positive for this specific, common case.

**Do:** recognize the shape instantly (single flagged commit, committer `noreply@github.com`, appearing right after a merge) and move on without re-investigating or re-explaining it.
**Don't:** amend/rewrite that commit and force-push to silence the hook. By the time it's flagged, that commit is usually already the tip of a shared branch (`main`) — rewriting and force-pushing over shared history to fix a cosmetic badge risks desyncing other clones/deployments (and can trigger an unwanted redeploy) for zero functional benefit. Never do this without the user explicitly asking.

This will keep re-triggering after every PR merge, for as long as the same local branch name gets reset to the base branch and reused (this project's standard commit → push → PR → merge → reset-branch rhythm) without deleting the merged feature branch's remote ref — the hook diffs against `origin/<branch-name>` when that ref still exists, and the merge commit is always one commit "ahead" of that now-stale ref. Expected, harmless, recurring noise — not a real problem to solve each time.

This is a separate issue from genuinely unsigned commits a session authors locally in a given environment — that's its own, already-accepted limitation (the environment's signing mechanism can be configured but doesn't actually produce a working signature) with no real fix available either, just a different root cause. (See `docs/DECISIONS.md`/`PROGRESS.md` — this project's commit history has been unsigned throughout for that reason.)

Note: a user-level `~/.claude/CLAUDE.md` does **not** persist across Claude Code on the web sessions — each session is a fresh, ephemeral container that clones this repo from GitHub, with no access to another session's container filesystem. Any note meant to survive across sessions on this project has to live in the repo itself (like this file), not under `~/.claude/`.
