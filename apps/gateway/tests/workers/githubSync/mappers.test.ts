import { describe, it, expect } from "vitest";
import {
  mapPullRow,
  mapReviewRows,
  mapIssueRow,
  mapProjectItemRow,
  DONE_STATUS_REGEX,
} from "../../../src/workers/githubSync/mappers.js";
import type { GithubApiPullDetail } from "../../../src/workers/githubSync/githubClient.js";

const ORG = "0b7e7d1e-0000-4000-8000-000000000001";

function makePull(overrides: Partial<GithubApiPullDetail> = {}): GithubApiPullDetail {
  return {
    number: 42,
    node_id: "PR_kw42",
    state: "closed",
    draft: false,
    title: "fix: thing",
    html_url: "https://github.com/acme/web/pull/42",
    user: { id: 777, login: "hanfour" },
    base: { ref: "main" },
    additions: 10,
    deletions: 3,
    changed_files: 2,
    commits: 1,
    review_comments: 4,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    merged_at: "2026-07-02T10:00:00Z",
    closed_at: "2026-07-02T10:00:00Z",
    ...overrides,
  };
}

describe("mapPullRow", () => {
  it("maps a merged PR with author ids", () => {
    const row = mapPullRow({ orgId: ORG, repoFullName: "acme/web", pull: makePull() });
    expect(row).toMatchObject({
      orgId: ORG,
      repoFullName: "acme/web",
      number: 42,
      ghNodeId: "PR_kw42",
      authorGhId: 777,
      authorLogin: "hanfour",
      state: "closed",
      draft: false,
      baseRef: "main",
      additions: 10,
      reviewCommentCount: 4,
    });
    expect(row.mergedAt).toEqual(new Date("2026-07-02T10:00:00Z"));
  });

  it("handles deleted (ghost) authors and open PRs", () => {
    const row = mapPullRow({
      orgId: ORG,
      repoFullName: "acme/web",
      pull: makePull({ user: null, state: "open", merged_at: null, closed_at: null }),
    });
    expect(row.authorGhId).toBeNull();
    expect(row.authorLogin).toBeNull();
    expect(row.mergedAt).toBeNull();
    expect(row.closedAt).toBeNull();
  });
});

describe("mapReviewRows", () => {
  it("drops PENDING and null-submitted reviews", () => {
    const rows = mapReviewRows({
      orgId: ORG,
      repoFullName: "acme/web",
      prGhNodeId: "PR_kw42",
      reviews: [
        { node_id: "R_1", user: { id: 5, login: "joe" }, state: "APPROVED", submitted_at: "2026-07-02T09:00:00Z" },
        { node_id: "R_2", user: { id: 5, login: "joe" }, state: "PENDING", submitted_at: null },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ghNodeId: "R_1",
      prGhNodeId: "PR_kw42",
      reviewerGhId: 5,
      state: "APPROVED",
    });
  });
});

describe("mapIssueRow", () => {
  it("maps assignees and closed_by to numeric ids", () => {
    const row = mapIssueRow({
      orgId: ORG,
      repoFullName: "acme/web",
      issue: {
        number: 7,
        node_id: "I_7",
        state: "closed",
        state_reason: "completed",
        title: "bug",
        html_url: "https://github.com/acme/web/issues/7",
        user: { id: 1, login: "a" },
        assignees: [{ id: 2, login: "b" }, { id: 3, login: "c" }],
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-03T00:00:00Z",
        closed_at: "2026-07-03T00:00:00Z",
        closed_by: { id: 2, login: "b" },
      },
    });
    expect(row.assigneeGhIds).toEqual([2, 3]);
    expect(row.closedByGhId).toBe(2);
    expect(row.stateReason).toBe("completed");
  });
});

describe("mapProjectItemRow / DONE_STATUS_REGEX", () => {
  it("marks Done-ish statuses as done", () => {
    for (const s of ["Done", "done", "Completed", "Shipped", "closed"]) {
      expect(DONE_STATUS_REGEX.test(s)).toBe(true);
    }
    for (const s of ["In Progress", "Todo", "Blocked", "Done-ish"]) {
      expect(DONE_STATUS_REGEX.test(s)).toBe(false);
    }
    const row = mapProjectItemRow({
      orgId: ORG,
      node: {
        itemNodeId: "PVTI_1",
        projectNodeId: "PVT_1",
        projectTitle: "Q3 Roadmap",
        contentType: "ISSUE",
        contentGhNodeId: "I_7",
        assigneeGhIds: [2],
        statusValue: "Done",
        ghUpdatedAt: "2026-07-03T00:00:00Z",
      },
    });
    expect(row.isDone).toBe(true);
    expect(row.ghUpdatedAt).toEqual(new Date("2026-07-03T00:00:00Z"));
  });
});
