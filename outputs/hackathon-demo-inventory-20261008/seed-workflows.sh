#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stage_dir=$(mktemp -d /tmp/quickhack-demo-workflows.XXXXXXXX)
trap 'rm -rf -- "$stage_dir"' EXIT
chmod 0755 "$stage_dir"
install -m 0644 "$source_dir/seed-workflows.mjs" "$stage_dir/seed-workflows.mjs"
install -m 0644 "$source_dir/inventory-example.csv" "$stage_dir/inventory-example.csv"
install -m 0644 "$source_dir/workflow-manifest.json" "$stage_dir/workflow-manifest.json"

/usr/bin/node "$stage_dir/seed-workflows.mjs" \
  --csv "$stage_dir/inventory-example.csv" \
  --manifest "$stage_dir/workflow-manifest.json" --validate-plan

run_seed() {
  phase=$1
  shift
  sudo /usr/bin/systemd-run --wait --collect --pipe \
    --unit="quickhack-demo-workflows-${phase}-$$" \
    --property=User=quickhack-demo \
    --property=Group=quickhack-demo \
    --property=LoadCredentialEncrypted=quickhack.postgresql.runtime:/var/lib/quickhack/security/quickhack.postgresql.runtime.cred \
    --working-directory=/usr/lib/quickhack/demonstration-server \
    /usr/bin/node "$stage_dir/seed-workflows.mjs" \
    --csv "$stage_dir/inventory-example.csv" \
    --manifest "$stage_dir/workflow-manifest.json" "$@"
}

run_seed check
run_seed apply --apply
run_seed verify --verify
