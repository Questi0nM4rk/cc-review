#!/usr/bin/env bash
# ============================================================================
#  memory-slice.sh — shared fetch/push for the cc-review memory branch slice.
#
#  SOURCED by both ci-run.sh (the review pipeline) and cc-review-cleanup.yml's
#  harvest step (learning-loop Phase 1) so the two read and write the per-repo
#  slice on `claude-reviewer/memory` the SAME way — a single implementation, no
#  drift (two divergent copies would let the harvester push a layout the review
#  pipeline doesn't expect).
#
#  A "slice" is one consumer repo's subtree on the bot's orphan branch
#  claude-reviewer/memory:  <owner>/<repo>/{MEMORY.md, learnings/, pr-<N>/...}
#  The bot clone is a shallow single-branch clone, so there is no
#  origin/<branch> tracking ref — always fetch explicitly and key off FETCH_HEAD.
# ============================================================================

# fetch_slice <bot_dir> <repo> <dest>
#   Extract <repo>/ from claude-reviewer/memory into <dest> (which must already
#   exist). No-op — leaves <dest> untouched — when the branch or the slice does
#   not exist yet (a repo's first-ever run). Never fails the caller.
fetch_slice() {
  local bot_dir="$1" repo="$2" dest="$3"
  if git -C "$bot_dir" fetch origin claude-reviewer/memory 2>/dev/null; then
    git -C "$bot_dir" archive FETCH_HEAD "${repo}/" 2>/dev/null \
      | tar -x -C "$dest" --strip-components=2 2>/dev/null || true
  fi
}

# fetch_global <bot_dir> <dest>
#   Extract the cross-repo `_global/` subtree from claude-reviewer/memory into <dest> (which must
#   already exist), stripping the `_global/` prefix → <dest>/learnings/*.md. This is the ADDITIVE
#   cross-project layer (general lessons / watch-patterns) every review reads IN ADDITION to its repo
#   slice. Staged in a SEPARATE dir from the repo slice (never under it) so push_slice can't copy it
#   into a per-repo subtree. Read-only for the review; only the maintenance job writes _global/. No-op
#   when the branch/subtree is absent. Never fails the caller.
fetch_global() {
  local bot_dir="$1" dest="$2"
  if git -C "$bot_dir" fetch origin claude-reviewer/memory 2>/dev/null; then
    git -C "$bot_dir" archive FETCH_HEAD "_global/" 2>/dev/null \
      | tar -x -C "$dest" --strip-components=1 2>/dev/null || true
  fi
}

# push_slice <bot_dir> <repo> <src> <commit_msg>
#   Commit <src>'s contents into <repo>/ on claude-reviewer/memory and push,
#   reusing the bot clone's authenticated origin. 3-attempt retry. No-op when
#   <src> is missing or there is nothing to commit. Runs git in a subshell so the
#   caller's cwd is unaffected (it does check out the memory branch in <bot_dir>,
#   which is fine for both callers — it's their last use of the clone).
push_slice() {
  local bot_dir="$1" repo="$2" src="$3" msg="$4"
  [ -d "$src" ] || { echo "no slice at $src to push"; return 0; }
  ( cd "$bot_dir" || exit 0   # exit (not return): this is a subshell, not a function frame
    git config user.name "cc-review[bot]"; git config user.email "cc-review[bot]@users.noreply.github.com"
    _attempt() {
      if git fetch origin claude-reviewer/memory 2>/dev/null; then
        git checkout -B claude-reviewer/memory FETCH_HEAD
      else
        git checkout --orphan claude-reviewer/memory; git rm -rf . 2>/dev/null || true
        printf '# cc-review memory\n\nPer-project palace. Each top dir is one consumer repo.\n' > README.md
        git add README.md; git commit -q -m "init memory"
      fi
      mkdir -p "$repo"
      cp -r "$src/." "$repo/" 2>/dev/null || true
      git add "$repo/"
      git diff --cached --quiet && { echo "no memory changes"; return 0; }
      git commit -q -m "$msg"; git push origin claude-reviewer/memory
    }
    for n in 1 2 3; do _attempt && break; echo "memory push retry $n"; sleep $((n * 5)); done
  )
}
