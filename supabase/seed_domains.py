#!/usr/bin/env python3
"""Print SQL that replaces kl_free_email_domains with the list in data/free-email-domains.txt.

Run: python3 supabase/seed_domains.py > /tmp/kl-domains.sql && sh supabase/apply.sh /tmp/kl-domains.sql
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOMAIN = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")


def domains():
    out = []
    for line in (ROOT / "data" / "free-email-domains.txt").read_text().splitlines():
        d = line.strip().lower()
        if not d or d.startswith("#"):
            continue
        if not DOMAIN.match(d):
            raise SystemExit(f"not a domain: {d!r}")
        out.append(d)
    return sorted(set(out))


if __name__ == "__main__":
    rows = ",\n".join(f"  ('{d}')" for d in domains())
    print("begin;\ndelete from public.kl_free_email_domains;\n"
          f"insert into public.kl_free_email_domains (domain) values\n{rows};\ncommit;")
