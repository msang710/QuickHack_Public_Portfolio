// Windows-specific stable entrypoint. The top-level file remains a compatibility
// entrypoint for existing automation and delegates to the same four-target builder.
await import("../create-staging-package.mjs");
