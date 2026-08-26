"""
QR 인코더 검증.

**판정 기준은 «실제로 읽히는가» 다.** 기준 구현(segno)과 행렬이 한 칸도 안 틀리는지가
아니다 — 마스크 선택은 «스캔이 잘 되는 쪽» 을 고르는 최적화라, 점수 계산이 조금
달라도 **둘 다 유효한 QR** 이 나온다. 교실에서 중요한 것은 폰이 읽느냐다.

그래서 이렇게 본다.
  1) 여러 배율에서 읽히는가 (칠판 가까이 · 교실 뒤)
  2) 흐릿해도 읽히는가 (손 떨림 · 초점 안 맞음)
  3) 조용한 여백(quiet zone)이 좁아도 읽히는가
  4) [참고] 기준 구현과 버전·마스크가 같은가 — 달라도 실패가 아니다

쓰는 법:  <scratchpad>/qrenv/Scripts/python.exe test/qr_check.py
"""
import json
import os
import subprocess
import sys

import numpy as np
import segno
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CASES = [
    "https://chan7881.github.io/quiz/?c=MGN72K",
    "https://chan7881.github.io/quiz/?c=ABC234",
    "http://127.0.0.1:8777/?c=ZZZZZZ",
    "https://example.org/",
    "A",
    "https://chan7881.github.io/quiz/?c=" + "Q" * 6,
    "https://some-rather-long-school-domain.example.org/quiz/room/?c=WXYZ23&x=1",
]


def js_debug(text):
    code = ("const qr=require(%s);process.stdout.write(JSON.stringify(qr.debug(%s)));"
            % (json.dumps(os.path.join(ROOT, "js", "qr.js").replace("\\", "/")),
               json.dumps(text)))
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("node 실패: " + out.stderr.strip())
    return json.loads(out.stdout)


def render(m, scale, quiet):
    n = len(m)
    size = (n + quiet * 2) * scale
    img = np.full((size, size), 255, dtype=np.uint8)
    for r in range(n):
        for c in range(n):
            if m[r][c]:
                img[(r + quiet) * scale:(r + quiet + 1) * scale,
                    (c + quiet) * scale:(c + quiet + 1) * scale] = 0
    return img


def try_decode(img, text):
    got, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    return got == text


def main():
    ok = bad = 0
    for text in CASES:
        label = text if len(text) <= 44 else text[:41] + "..."
        try:
            d = js_debug(text)
        except Exception as e:
            print("  FAIL %-44s 인코더가 터짐: %s" % (label, e))
            bad += 1
            continue
        m = d["matrix"]

        fails = []
        # 1) 배율 — 작게 찍혀도, 크게 띄워도
        for scale in (3, 4, 6, 10, 20):
            if not try_decode(render(m, scale, 4), text):
                fails.append("배율%d" % scale)
        # 2) 흐릿함 — 초점이 안 맞은 카메라
        for k in (3, 5, 7):
            img = cv2.GaussianBlur(render(m, 10, 4), (k, k), 0)
            if not try_decode(img, text):
                fails.append("흐림%d" % k)
        # 3) 여백이 좁을 때
        for quiet in (2, 3, 4):
            if not try_decode(render(m, 8, quiet), text):
                fails.append("여백%d" % quiet)

        q = segno.make(text, error="m", mode="byte", boost_error=False, micro=False)
        same = "같음" if (q.version == d["version"] and q.mask == d["mask"]) else \
               "다름(v%s/m%s)" % (q.version, q.mask)

        if not fails:
            print("  OK   %-44s v%d mask%d %dx%d · 기준과 %s"
                  % (label, d["version"], d["mask"], len(m), len(m), same))
            ok += 1
        else:
            print("  FAIL %-44s 못 읽음: %s" % (label, ", ".join(fails)))
            bad += 1

    print("\n합계: %d 통과 / %d 실패" % (ok, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
