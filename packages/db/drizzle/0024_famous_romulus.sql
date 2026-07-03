-- down: 0024_down.sql — drop organizations.agent_poll_interval_seconds
ALTER TABLE "organizations" ADD COLUMN "agent_poll_interval_seconds" integer;