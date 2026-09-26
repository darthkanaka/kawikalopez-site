"""Markdown content for place pages and posts: loading, frontmatter and rendering.

Content is written in Obsidian at ~/Documents/Obsidian/kawikalopez/{places,posts}/ and copied
into content/ by tools/sync_content.py. The build reads only content/, so a fresh clone builds.

Frontmatter is plain YAML between --- lines. Fields the build uses:

  places/<slug>.md   place (key in data/locations.yml), title, target, description, hero,
                     status (draft or published), date
  posts/<slug>.md    title, slug, target, description, hero, prints, places, status, date, updated

Inside the text, three shorthand forms link to the rest of the site without knowing where it
is hosted:

  [Mālie](print:malie)          a link to a print page
  [Makapuʻu](place:makapuu)     a link to a place page
  [sizes](page:prints)          a link to any other page by its path

and a line on its own like

  [print:malie]                 shows the print as a picture with its title and price
  [prints:malie, eleu, hookahi] shows several side by side
"""

import re
from pathlib import Path

import markdown
import yaml

FM = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.S)
CARD_LINE = re.compile(r"^\[(print|prints):\s*([a-z0-9,\s\-]+)\]\s*$", re.M)


def parse_frontmatter(text):
    m = FM.match(text)
    if not m:
        return {}, text
    meta = yaml.safe_load(m.group(1)) or {}
    return meta, m.group(2)


def load_docs(folder, warn):
    docs = []
    for f in sorted(Path(folder).glob("*.md")):
        meta, body = parse_frontmatter(f.read_text())
        meta = dict(meta)
        meta.setdefault("slug", f.stem)
        meta["status"] = str(meta.get("status", "draft")).strip().lower()
        meta["file"] = str(f)
        meta["body"] = body
        for k in ("date", "updated"):
            if meta.get(k) is not None:
                meta[k] = str(meta[k])
        if not meta.get("title"):
            warn.add(f"{f.name}: no title, skipped")
            continue
        docs.append(meta)
    return docs


def render(body, link_for, card_for):
    """Markdown to HTML with the shorthand links and print cards expanded.

    link_for(kind, key) -> href or None; card_for([ids]) -> HTML or ''."""
    tokens = {}

    def stash(m):
        ids = [x.strip() for x in m.group(2).split(",") if x.strip()]
        key = f"KLCARD{len(tokens)}X"
        tokens[key] = card_for(ids)
        return f"\n\n{key}\n\n"

    body = CARD_LINE.sub(stash, body)
    out = markdown.markdown(body, extensions=["extra", "sane_lists", "attr_list"], output_format="html")

    def relink(m):
        kind, key = m.group(1), m.group(2)
        href = link_for(kind, key)
        return f'href="{href}"' if href else 'href="#missing-' + key + '"'

    out = re.sub(r'href="(print|place|page):([^"]*)"', relink, out)
    for key, html in tokens.items():
        out = out.replace(f"<p>{key}</p>", html)
    return out


def reading_minutes(body):
    words = len(re.findall(r"\w+", body))
    return max(1, round(words / 220))
