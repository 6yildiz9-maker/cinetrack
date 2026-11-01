# Project memory

## Product intent & audience

- App syncs user data (per-user) and catalog/derived cache (public movie/TV data) via GitHub sync engine.
- Migration in progress: moving persistence from local files to a database (Supabase/postgres-style with service-role access, RLS).

## Brand personality & voice

- No inferred brand context yet.

## Visual design & UX direction

- No inferred visual/UX context yet.

## Decisions, constraints & rationale

- **Standing rule:** use the database unless the user says otherwise (user confirmed full catalog/cache migration).
- **Storage layer pattern:** repository modules — plain rows in, plain rows out; store/business logic handles domain rules. User-data repository already exists as the reference pattern.
- **DB schema:** catalog and cache tables already have primary keys and RLS enabled; service-role grants were added this pass.
- **GitHub sync engine:** user-data read/write paths fully converted to database; writes go through `applySyncedDocumentSerialized`. Storage field made required (file fallbacks removed).
- **Catalog store:** ~3,768 lines, has both sync and async versions of many methods; file-based sync pipeline reads/hashes/stages/writes by file path. Full DB migration requires reworking ~1,500 lines across catalog store + sync engine.
- **Framework:** vite-react.

## Open questions & assumptions

- **Catalog store migration:** not started — need to remove file-based code, wire callers to DB storage module, rework sync pipeline for catalog/cache content from DB.
- **Sync engine catalog/cache paths:** still read from local files; need DB content source.
- **Tests:** 35 failing (up from 29 baseline); tests need DB stand-in/mocks. Build passes.
- **Lint:** one type error remains in sync-status function (reads catalog files synchronously without await).
- **Local-file check:** not yet run — need to confirm no user data is written to local files after migration.
- **Catalog storage module:** written but not yet wired into the catalog store or callers.