-- Seed data: the skills and developers from docs/requirement.md → Domain model. No tasks.
-- Ids are fixed UUIDv7 literals so tests can refer to Alice or Frontend by id.
-- They share the timestamp prefix 01a1bd9a-c800 (2026-11-09T00:00:00Z); the last digits tell them apart.

INSERT INTO skill (id, name) VALUES
  ('01a1bd9a-c800-7000-8000-000000000001', 'Frontend'),
  ('01a1bd9a-c800-7000-8000-000000000002', 'Backend');

INSERT INTO developer (id, name) VALUES
  ('01a1bd9a-c800-7000-8000-000000000101', 'Alice'),
  ('01a1bd9a-c800-7000-8000-000000000102', 'Bob'),
  ('01a1bd9a-c800-7000-8000-000000000103', 'Carol'),
  ('01a1bd9a-c800-7000-8000-000000000104', 'Dave');

INSERT INTO developer_skill (developer_id, skill_id) VALUES
  ('01a1bd9a-c800-7000-8000-000000000101', '01a1bd9a-c800-7000-8000-000000000001'), -- Alice: Frontend
  ('01a1bd9a-c800-7000-8000-000000000102', '01a1bd9a-c800-7000-8000-000000000002'), -- Bob: Backend
  ('01a1bd9a-c800-7000-8000-000000000103', '01a1bd9a-c800-7000-8000-000000000001'), -- Carol: Frontend
  ('01a1bd9a-c800-7000-8000-000000000103', '01a1bd9a-c800-7000-8000-000000000002'), -- Carol: Backend
  ('01a1bd9a-c800-7000-8000-000000000104', '01a1bd9a-c800-7000-8000-000000000002'); -- Dave: Backend
