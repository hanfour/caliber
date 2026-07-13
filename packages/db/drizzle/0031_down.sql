DELETE FROM rubrics WHERE org_id IS NULL AND version = '2.0.0' AND is_default = false;
