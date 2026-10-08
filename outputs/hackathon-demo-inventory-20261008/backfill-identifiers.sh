#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stage_dir=$(mktemp -d /tmp/quickhack-demo-identifiers.XXXXXXXX)
trap 'rm -rf -- "$stage_dir"' EXIT
chmod 0755 "$stage_dir"
install -m 0644 "$source_dir/backfill-identifiers.mjs" "$stage_dir/backfill-identifiers.mjs"
install -m 0644 "$source_dir/inventory-example.csv" "$stage_dir/inventory-example.csv"

run_backfill() {
  phase=$1
  shift
  sudo /usr/bin/systemd-run --wait --collect --pipe \
    --unit="quickhack-demo-identifiers-${phase}-$$" \
    --property=User=quickhack-demo \
    --property=Group=quickhack-demo \
    --property=LoadCredentialEncrypted=quickhack.postgresql.runtime:/var/lib/quickhack/security/quickhack.postgresql.runtime.cred \
    --working-directory=/usr/lib/quickhack/demonstration-server \
    /usr/bin/node "$stage_dir/backfill-identifiers.mjs" \
    --csv "$stage_dir/inventory-example.csv" "$@"
}

run_backfill check
run_backfill apply --apply
run_backfill verify --verify
