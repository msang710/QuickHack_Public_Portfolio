# QuickHack development workflow

QuickHack uses pull requests as the verification boundary for changes to `main`.
This applies even when one person is developing the project.

## Standard flow

1. Update local `main`.
2. Create a short-lived branch such as `codex/coupang-invoice-api`.
3. Open a draft pull request early for work that spans multiple commits.
4. Run `npm run verify` locally before marking the pull request ready.
5. Confirm that the `Pull request checks` workflow succeeds.
6. Squash merge into `main` and delete the feature branch.

Do not create release tags from a feature branch. Version tags must point to a
verified commit on `main`.

## Workflow boundaries

- Pull request: required type checking, mock Coupang authentication test, and
  build; non-blocking lint report until the existing baseline is cleared
- Push to `main`: demo server and client package generation
- Version tag: verified packages plus GitHub Release publication

Keep each pull request focused on one operational outcome. Record DB changes,
state transitions, external API behavior, retry safety, and UI verification in
the pull request template when they apply.
