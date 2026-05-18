import { router } from "./procedures.js";
import { meRouter } from "./routers/me.js";
import { organizationsRouter } from "./routers/organizations.js";
import { departmentsRouter } from "./routers/departments.js";
import { teamsRouter } from "./routers/teams.js";
import { usersRouter } from "./routers/users.js";
import { invitesRouter } from "./routers/invites.js";
import { rolesRouter } from "./routers/roles.js";
import { auditLogsRouter } from "./routers/audit-logs.js";
import { accountsRouter } from "./routers/accounts.js";
import { accountGroupsRouter } from "./routers/accountGroups.js";
import { apiKeysRouter } from "./routers/apiKeys.js";
import { usageRouter } from "./routers/usage.js";
import { contentCaptureRouter } from "./routers/contentCapture.js";
import { rubricsRouter } from "./routers/rubrics.js";
import { reportsRouter } from "./routers/reports.js";
import { evaluatorRouter } from "./routers/evaluator.js";
import { devicesRouter } from "./routers/devices.js";

export const appRouter = router({
  me: meRouter,
  organizations: organizationsRouter,
  departments: departmentsRouter,
  teams: teamsRouter,
  users: usersRouter,
  invites: invitesRouter,
  roles: rolesRouter,
  auditLogs: auditLogsRouter,
  accounts: accountsRouter,
  accountGroups: accountGroupsRouter,
  apiKeys: apiKeysRouter,
  usage: usageRouter,
  contentCapture: contentCaptureRouter,
  rubrics: rubricsRouter,
  reports: reportsRouter,
  evaluator: evaluatorRouter,
  devices: devicesRouter,
});

export type AppRouter = typeof appRouter;
