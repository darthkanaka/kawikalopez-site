#!/bin/sh
# Apply SQL to the Veex Supabase project (the realtor program's kl_ tables) through the
# management API. Same method as veex-fantasy/supabase/apply.sh: curl, not Python's urllib,
# because Cloudflare in front of api.supabase.com refuses urllib (error 1010), and the body is
# built with json.dumps so the SQL needs no escaping.
#
# Run: SUPABASE_ACCESS_TOKEN=... sh supabase/apply.sh supabase/realtors.sql
# The token is the Evolve HI account's, in ~/.claude/credentials/supabase-evolve-hi.env.
set -eu
REF="pnipcitilwmhmfjulpmd"
[ $# -ge 1 ] || { echo "usage: apply.sh <file.sql> [more.sql ...]" >&2; exit 2; }
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN first}"
TMP="$(mktemp)"
for f in "$@"; do
  echo "applying $f"
  python3 -c "import json,sys; print(json.dumps({'query': open(sys.argv[1]).read()}))" "$f" > "$TMP"
  curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data @"$TMP"
  echo
done
rm -f "$TMP"
