"""
SVG 렌더러까지 검증한다.

행렬이 맞아도 **그리는 데서 틀리면** 못 읽는다(좌표 뒤집힘·여백 누락 등).
그래서 qr.svg() 가 내놓은 SVG 의 path 를 도로 파싱해 행렬을 복원하고,
그것을 opencv 로 디코딩한다.

쓰는 법:  <scratchpad>/qrenv/Scripts/python.exe test/qr_svg_check.py
"""
import json
import os
import re
import subprocess
import sys

import numpy as np
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CASES = [
    "http://127.0.0.1:8777/?c=C26FWX",
    "https://chan7881.github.io/quiz/?c=MGN72K",
    "https://chan7881.github.io/quiz/?c=AB23CD",
]


def js_svg(text):
    code = ("const qr=require(%s);process.stdout.write(qr.svg(%s));"
            % (json.dumps(os.path.join(ROOT, "js", "qr.js").replace("\\", "/")),
               json.dumps(text)))
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr.strip())
    return out.stdout


def svg_to_matrix(svg):
    vb = re.search(r'viewBox="0 0 (\d+) (\d+)"', svg)
    size = int(vb.group(1))
    grid = np.zeros((size, size), dtype=np.uint8)
    for x, y in re.findall(r"M(\d+) (\d+)h1v1h-1z", svg):
        grid[int(y)][int(x)] = 1
    return grid


def main():
    ok = bad = 0
    det = cv2.QRCodeDetector()
    for text in CASES:
        svg = js_svg(text)
        grid = svg_to_matrix(svg)
        size = grid.shape[0]

        fails = []
        for scale in (4, 8, 16):
            img = np.where(np.kron(grid, np.ones((scale, scale), np.uint8)) > 0, 0, 255)
            img = img.astype(np.uint8)
            got, _, _ = det.detectAndDecode(img)
            if got != text:
                fails.append("배율%d(%r)" % (scale, got[:20]))

        if fails:
            print("  FAIL %-44s %s" % (text[:44], ", ".join(fails)))
            bad += 1
        else:
            print("  OK   %-44s SVG %dx%d 칸 · 디코딩 성공" % (text[:44], size, size))
            ok += 1

    print("\n합계: %d 통과 / %d 실패" % (ok, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
