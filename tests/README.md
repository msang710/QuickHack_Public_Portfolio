# QuickHack test source layout

`tests/` owns executable verification source. `tools/` is reserved for development and
operational commands that are also meaningful outside the test runner.

## Ownership

- `contracts/`: static source, configuration, schema, workflow, package, and dependency-boundary contracts.
- `regression/`: deterministic product and service behavior that does not require an OS-native service or a live PostgreSQL scope.
- `integration/postgresql/`: tests and runners that create an isolated PostgreSQL schema or exercise the Prisma/PostgreSQL integration graph.
- `integration/windows/`: Windows-native PowerShell, service, DPAPI, ACL, and Windows workflow verification.
- `visual/`: render, capture, layout, and visual-output contracts.
- `support/`: test-only fixtures, loaders, manifests, the TypeScript alias hook, and the shared repository-root resolver.

The PR-02 migration inventory was 208 `tools/test-*.mjs` entries: 207 test entries moved
under this tree and one package-time least-privilege check became
`tools/verify-postgresql-operational-roles.mjs`. Ten shared support files and six other
test-only sources moved with the test graph. New layout/package boundary contracts are
additional test entries, not part of that 208-file migration inventory.

## Execution contract

- npm test script names remain stable except the operational command, which is
  `verify:postgresql-operational-roles`.
- Commands run with the repository root as their working directory. Tests that need an
  absolute source root import `projectRoot` from `tests/support/project-root.mjs` or
  calculate the equivalent path from their own file.
- OS-native integration tests print `NON_APPLICABLE` on unsupported operating systems;
  the owning OS gate must execute them normally.
- Old-path wrappers and aliases are intentionally forbidden. Imports, npm scripts,
  workflows, and package manifests must point to the owning source directly.
- Runtime packages may contain required `tools/verify-*` operational commands, but must
  not contain `tests/`, `specs/`, `.agents/`, portfolio sources, screenshots, generated
  reports, or temporary test artifacts.
