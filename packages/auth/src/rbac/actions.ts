export type Role =
  | "super_admin"
  | "org_admin"
  | "dept_manager"
  | "team_manager"
  | "member";

export type ScopeType = "global" | "organization" | "department" | "team";

export const ROLE_RANK: Record<Role, number> = {
  super_admin: 50,
  org_admin: 40,
  dept_manager: 30,
  team_manager: 20,
  member: 10,
};

export type Action =
  | { type: "org.read"; orgId: string }
  | { type: "org.update"; orgId: string }
  | { type: "org.create" }
  | { type: "org.delete"; orgId: string }
  | { type: "dept.read"; orgId: string; deptId: string }
  | { type: "dept.create"; orgId: string }
  | { type: "dept.update"; orgId: string; deptId: string }
  | { type: "dept.delete"; orgId: string; deptId: string }
  | { type: "team.read"; teamId: string }
  | { type: "team.create"; orgId: string; deptId?: string }
  | { type: "team.update"; teamId: string }
  | { type: "team.delete"; teamId: string }
  | { type: "team.add_member"; teamId: string }
  | { type: "user.read"; targetUserId: string }
  | { type: "user.invite"; orgId: string; deptId?: string; teamId?: string }
  | {
      type: "role.grant";
      targetUserId: string;
      role: Role;
      scopeType: ScopeType;
      scopeId: string | null;
    }
  | { type: "role.revoke"; assignmentOwnerId: string }
  | { type: "audit.read"; orgId: string; deptId?: string }
  | { type: "account.read"; orgId: string }
  | { type: "account.create"; orgId: string; teamId: string | null }
  | { type: "account.update"; orgId: string; accountId: string }
  | { type: "account.rotate"; orgId: string; accountId: string }
  | { type: "account.delete"; orgId: string; accountId: string }
  | { type: "account_group.read"; orgId: string }
  | { type: "account_group.create"; orgId: string }
  | { type: "account_group.update"; orgId: string; groupId: string }
  | { type: "account_group.delete"; orgId: string; groupId: string }
  | { type: "account_group.manage_members"; orgId: string; groupId: string }
  | { type: "api_key.issue_own" }
  | { type: "api_key.issue_for_user"; orgId: string; targetUserId: string }
  | { type: "api_key.list_own" }
  | { type: "api_key.list_all"; orgId: string }
  | {
      type: "api_key.revoke";
      apiKeyId: string;
      orgId: string;
      ownerUserId: string;
    }
  | { type: "usage.read_own" }
  | { type: "usage.read_user"; orgId: string; targetUserId: string }
  | { type: "usage.read_team"; orgId: string; teamId: string }
  | { type: "usage.read_org"; orgId: string }
  | { type: "content_capture.read"; orgId: string }
  | { type: "content_capture.toggle"; orgId: string }
  | { type: "report.read_own" }
  | { type: "report.read_user"; orgId: string; targetUserId: string }
  | { type: "report.read_team"; orgId: string; teamId: string }
  | { type: "report.read_org"; orgId: string }
  | {
      type: "report.rerun";
      orgId: string;
      targetUserId: string;
      periodStart: string;
    }
  | { type: "report.export_own" }
  | { type: "report.delete_own" }
  | { type: "rubric.read"; orgId: string }
  | { type: "rubric.create"; orgId: string }
  | { type: "rubric.update"; orgId: string; rubricId: string }
  | { type: "rubric.delete"; orgId: string; rubricId: string }
  | { type: "evaluator.read_status"; orgId: string }
  | { type: "evaluator.view_cost"; orgId: string }
  | { type: "device.list_own" }
  | { type: "device.list_all"; orgId: string }
  | {
      type: "device.revoke";
      deviceId: string;
      orgId: string;
      ownerUserId: string;
    }
  | { type: "enrollment_token.issue_own" }
  | {
      type: "enrollment_token.issue_for_user";
      orgId: string;
      targetUserId: string;
    };
