# Posting a PR review via `gh` + GraphQL

Reference for posting a single, atomic PR review with inline comments via the GitHub API. The `qsm-strict-review` plugin handles this end-to-end at runtime — this doc exists for debugging, manual recovery, and as the canonical "how cc-review expects reviews to be posted" record.

## The one rule

**A review is one API call, not many.** Every inline comment lives inside the `comments` array of a single `submitReview` mutation (or `POST /repos/.../pulls/N/reviews`). Never post inline comments via separate `POST /repos/.../pulls/comments` calls — they end up as orphan comments not attached to any review state, branch protection won't honour them, and the PR ends up cluttered with un-grouped comments.

## REST: `POST /repos/{owner}/{repo}/pulls/{pr}/reviews`

Simplest path. One call, one review.

```bash
gh api "repos/${OWNER}/${REPO}/pulls/${PR}/reviews" \
  --method POST \
  --input /tmp/review-payload.json
```

Where `/tmp/review-payload.json` is:

```json
{
  "body": "Summary text shown above the inline comments. Include any out-of-diff findings here as bullet points with **`path`**: <issue> references.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "When `user` is undefined, `user.active` throws TypeError. The token-decode path on line 38 can return null."
    },
    {
      "path": "src/db.ts",
      "start_line": 10,
      "line": 14,
      "side": "RIGHT",
      "body": "Multi-line comment spanning the new transaction block."
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `body` | Yes | Markdown summary. If empty string, GitHub renders a tiny review with just inline comments — usually you want at least a one-line summary. |
| `event` | Yes | `APPROVE` (zero findings), `REQUEST_CHANGES` (any required fix), or `COMMENT` (informational). cc-review never uses `COMMENT`. |
| `comments` | No | Array of inline comments. Each must reference a line that exists in the PR's diff. |
| `comments[].path` | Yes | Path relative to repo root, matches the diff exactly. |
| `comments[].line` | Yes | Line number in the **new** file (for `side: RIGHT`) or the **old** file (`side: LEFT`). Must be a line touched by the diff or in its hunk context — commenting on an unrelated line returns `422 Unprocessable Entity`. |
| `comments[].side` | Yes | `RIGHT` for added/context lines on the new file; `LEFT` for removed lines on the old file. |
| `comments[].start_line` | No | First line of a multi-line comment. `start_side` defaults to `side` if omitted. |
| `comments[].body` | Yes | Markdown content of the inline comment. |

## GraphQL: `addPullRequestReview` mutation

When you need finer control (resolving threads in the same call, working with review-level metadata, atomic submission across multiple reviews), use GraphQL.

```graphql
mutation PostReview(
  $prId: ID!
  $body: String!
  $event: PullRequestReviewEvent!
  $comments: [DraftPullRequestReviewComment!]!
) {
  addPullRequestReview(input: {
    pullRequestId: $prId
    body: $body
    event: $event
    comments: $comments
  }) {
    pullRequestReview {
      id
      state
      url
    }
  }
}
```

Get `pullRequestId` once before posting:
```bash
gh api graphql -f query='
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) { id }
    }
  }' -F owner="$OWNER" -F name="$REPO" -F pr=$PR --jq '.data.repository.pullRequest.id'
```

GraphQL's `DraftPullRequestReviewComment` shape uses `position` (1-based offset into the diff hunk) instead of `line` — different from REST. Most callers prefer REST for that reason; reach for GraphQL only when batching.

## Resolving threads

After posting a `REQUEST_CHANGES` review, each inline comment becomes a *review thread*. Once the issue is fixed, resolve the thread:

```graphql
mutation Resolve($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
```

```bash
gh api graphql -f query='...above...' -F threadId="$NODE_ID"
```

Fetch unresolved threads first:
```bash
gh api graphql -f query='
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) { nodes { body } }
          }
        }
      }
    }
  }' -F owner="$OWNER" -F name="$REPO" -F pr=$PR
```

## Approval guard

Before posting an `APPROVE` event, verify there are no unresolved threads — branch protection often requires it, and approving with open threads is misleading. Use the same `reviewThreads` query above, count `nodes | filter(!isResolved)`, and refuse to approve if the count is non-zero.

## Common 422 causes

| Symptom | Cause | Fix |
|---|---|---|
| `Pull request review thread comments must be on a line in the diff` | Line not in any diff hunk | Pick a line in an `@@ ... @@` range; or move the comment into the review `body`. |
| `path: must be a valid path in the diff` | Path doesn't match `diff --git b/<path>` | Copy the path verbatim from `gh pr diff`. |
| `start_line must be smaller than line` | Multi-line bounds inverted | Swap `start_line` and `line`. |
| Empty review posted | `event` was `null` or omitted | Always set `event` to one of `APPROVE`/`REQUEST_CHANGES`/`COMMENT`. |

## What cc-review does today

`qsm-strict-review`'s `review-synthesizer` agent assembles findings, deduplicates, formats them into the payload above, and POSTs once. If the synthesizer ever drifts from this contract, this doc is the contract.
