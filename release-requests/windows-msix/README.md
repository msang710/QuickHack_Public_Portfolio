# Windows MSIX release requests

Production Windows publication is manual and fail-closed. Add one reviewed JSON file only after all of the following are available:

- an exact source revision with a successful `Final integration gate` run;
- the verified production certificate Publisher subject;
- an approved Azure Artifact Signing profile, or an approved CA certificate already installed on an isolated self-hosted signing runner;
- Windows 10 and Windows 11 workstation evidence for the exact signed package hashes.

The request schema is exact:

```json
{
  "schemaVersion": 1,
  "attempt": 1,
  "version": "2.0.0",
  "tag": "windows-v2.0.0",
  "sourceCommit": "0000000000000000000000000000000000000000",
  "targets": ["demo-server", "demo-client", "operational-server", "operational-client"],
  "publisher": "CN=Verified Publisher, O=Verified Organization",
  "signingProvider": "AZURE_ARTIFACT_SIGNING",
  "prerelease": false
}
```

Do not commit the example. The validator rejects development Publishers, partial target sets, unknown fields, and any version or tag that appeared in an earlier request addition, including a deleted request. A candidate workflow only signs and uploads a private workflow artifact. Public tag/release creation additionally requires an explicit `publish=true` dispatch and the exact two workstation evidence run IDs.
