"""ゲーム一式を1つのHTMLファイルにまとめる。

index.html の <link rel="stylesheet" href="..."> と <script src="..."></script> を、
中身を埋め込んだ <style> / <script> に置き換える。

使い方: python build.py
出力:   dist/puyotetris.html  … ダブルクリックで遊べる1ファイル版

Web への公開（Cloudflare Pages）は Git と同期していて、ルートの index.html（js・css は別ファイル）をそのまま使うので、
この1ファイル版は要らない。
"""

import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")


def read(relative_path):
    with open(os.path.join(ROOT, relative_path), encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"{os.path.relpath(path, ROOT)}  {len(text.encode('utf-8')):,} bytes")


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

    write(os.path.join(DIST, "puyotetris.html"), html)


if __name__ == "__main__":
    main()
