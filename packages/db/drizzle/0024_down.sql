-- down: organizations.agent_poll_interval_seconds rollback
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "agent_poll_interval_seconds";
