#!/usr/bin/env python3
"""Copy the site's writing from the Obsidian vault into content/.

  ~/Documents/Obsidian/kawikalopez/places/*.md  ->  content/places/
  ~/Documents/Obsidian/kawikalopez/posts/*.md   ->  content/posts/

One direction only: the vault is where Kawika and Claude write; content/ is what the build
reads and what gets committed. Files removed from the vault are removed from content/.
Notes with status: draft still sync; the build shows them on staging with a draft label and
leaves them out of the production site. The folder's README.md is not copied.

Run: python3 tools/sync_content.py [--vault PATH]
"""

import argparse
import filecmp
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VAULT = Path.home() / "Documents" / "Obsidian" / "kawikalopez"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    a = ap.parse_args(argv)
    vault = Path(a.vault)
    if not vault.exists():
        print(f"no vault folder at {vault}")
        return 1
    changed = 0
    for kind in ("places", "posts"):
        src, dst = vault / kind, ROOT / "content" / kind
        dst.mkdir(parents=True, exist_ok=True)
        names = set()
        for f in sorted(src.glob("*.md")) if src.exists() else []:
            names.add(f.name)
            target = dst / f.name
            if not target.exists() or not filecmp.cmp(f, target, shallow=False):
                shutil.copy2(f, target)
                print(f"  {kind}/{f.name}")
                changed += 1
        for f in dst.glob("*.md"):
            if f.name not in names:
                f.unlink()
                print(f"  removed {kind}/{f.name}")
                changed += 1
    print(f"synced from {vault}: {changed} file(s) changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
