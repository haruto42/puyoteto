"""ゲーム一式を1つのHTMLファイルにまとめ、そのbase64版も作る。

index.html の <link rel="stylesheet" href="..."> と <script src="..."></script> を、
中身を埋め込んだ <style> / <script> に置き換える。

使い方: python build.py
出力:   dist/puyotetris.html         … ダブルクリックで遊べる1ファイル版
        dist/site/index.html        … 上と同じ中身。フォルダごと Web に公開するとき用
        dist/puyotetris.base64.txt  … 上のHTML（UTF-8）をbase64にした文字列
"""

import base64
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")


def read(relative_path):
    with open(os.path.join(ROOT, relative_path), encoding="utf-8") as f:
        return f.read()


def check_embeddable(content, tag, path):
    # 中に </script> や </style> があると、埋め込んだときにそこでタグが閉じて壊れる
    if re.search(rf"</{tag}", content, re.IGNORECASE):
        raise SystemExit(f"{path} に </{tag} が含まれているため埋め込めません")


def inline_style(match):
    path = match.group(1)
    content = read(path)
    check_embeddable(content, "style", path)
    return f"<style>\n{content}</style>"


def inline_script(match):
    path = match.group(1)
    content = read(path)
    check_embeddable(content, "script", path)
    return f"<script>\n{content}</script>"


def main():
    html = read("index.html")
    # 置き換え後の文字列に含まれる \ などを正規表現の記号として扱わないよう、関数で置き換える
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', inline_style, html)
    html = re.sub(r'<script src="([^"]+)"></script>', inline_script, html)

    os.makedirs(DIST, exist_ok=True)
    html_path = os.path.join(DIST, "puyotetris.html")
    with open(html_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    # Cloudflare Pages などに置く用：フォルダごとアップロードできるよう index.html という名前でも出す
    site_dir = os.path.join(DIST, "site")
    os.makedirs(site_dir, exist_ok=True)
    with open(os.path.join(site_dir, "index.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    encoded = base64.b64encode(html.encode("utf-8")).decode("ascii")
    txt_path = os.path.join(DIST, "puyotetris.base64.txt")
    with open(txt_path, "w", encoding="ascii", newline="\n") as f:
        f.write(encoded)

    print(f"{os.path.relpath(html_path, ROOT)}  {len(html.encode('utf-8')):,} bytes")
    print(f"{os.path.relpath(txt_path, ROOT)}  {len(encoded):,} chars")


if __name__ == "__main__":
    main()
