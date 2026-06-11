from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
DIARY_DIR = ROOT / "diary"
POSTS_JSON = DIARY_DIR / "posts.json"


def parse_front_matter(text: str):
    meta = {}
    body = text
    match = re.match(r"^---\s*\n([\s\S]*?)\n---\s*\n?", text)
    if not match:
        return meta, body

    body = text[match.end():]
    for line in match.group(1).splitlines():
        pair = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not pair:
            continue
        value = pair.group(2).strip().strip('"\'')
        meta[pair.group(1)] = value
    return meta, body


def first_heading(body: str, fallback: str):
    match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
    return match.group(1).strip() if match else fallback


def first_paragraph(body: str):
    cleaned = re.sub(r"```[\s\S]*?```", " ", body)
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = re.sub(r"^#+\s+.*$", " ", cleaned, flags=re.MULTILINE)

    for paragraph in re.split(r"\n\s*\n", cleaned):
        paragraph = " ".join(paragraph.split())
        if paragraph and paragraph != "---":
            return paragraph[:90]
    return ""


def first_image(body: str, md_file: Path):
    match = re.search(r"!\[[^\]]*\]\(([^)]+)\)", body)
    if not match:
        return ""
    src = match.group(1).strip()
    if src.startswith(("http://", "https://", "/")):
        return src
    resolved = (md_file.parent / src).resolve()
    try:
        rel = resolved.relative_to(ROOT.resolve())
    except ValueError:
        return ""
    return rel.as_posix() if resolved.exists() else ""


def date_from_filename(path: Path):
    match = re.match(r"(\d{4}-\d{2}-\d{2})", path.stem)
    return match.group(1) if match else ""


def collect_diary_posts():
    posts = []
    for path in sorted(DIARY_DIR.glob("*.md")):
        if path.name == "index.md":
            continue

        text = path.read_text(encoding="utf-8")
        meta, body = parse_front_matter(text)
        thumbnail = meta.get("thumbnail") or first_image(body, path)

        post = {
            "file": f"diary/{path.name}",
            "title": meta.get("title") or first_heading(body, path.stem),
            "date": meta.get("date") or date_from_filename(path),
            "category": meta.get("category") or meta.get("tag") or "",
            "description": meta.get("description") or first_paragraph(body),
        }
        if thumbnail:
            post["thumbnail"] = thumbnail
        posts.append(post)

    posts.sort(key=lambda item: item.get("date", ""), reverse=True)
    return posts


def main():
    posts = collect_diary_posts()
    POSTS_JSON.write_text(json.dumps(posts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"updated: {POSTS_JSON}")
    print(f"entries: {len(posts)}")


if __name__ == "__main__":
    main()
