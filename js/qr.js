/**
 * QR 코드 만들기 — 바깥 라이브러리 없이.
 *
 * ⚠️ 왜 직접 짜나: CDN 에서 받아 쓰면 **학교 와이파이가 막거나 느린 그 순간
 *    수업이 멈춘다.** 이 앱의 나머지가 전부 자기완결이라 여기만 예외를 둘 수 없다.
 *
 * 범위를 일부러 좁혔다 — 우리는 짧은 URL 하나만 넣는다.
 *   · 바이트 모드만 (URL 은 ASCII)
 *   · 오류정정 M 고정
 *   · 버전 1~6 (최대 106바이트). 7 이상은 버전 정보 블록이 더 필요한데 쓸 일이 없다.
 *
 * 검증: test/qr_check.py 가 segno(기준 인코더)와 **행렬을 한 칸씩 대조**하고,
 *       opencv 로 **실제로 디코딩**해 본다. 눈으로 보고 "맞겠지" 하지 않는다.
 */
(function () {
  "use strict";

  // ── 갈루아 체 GF(256), 원시다항식 0x11d ─────────────────────
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // 오류정정 다항식
  function genPoly(deg) {
    var p = [1];
    for (var i = 0; i < deg; i++) {
      var np = new Array(p.length + 1).fill(0);
      for (var j = 0; j < p.length; j++) {
        np[j] ^= mul(p[j], 1);
        np[j + 1] ^= mul(p[j], EXP[i]);
      }
      p = np;
    }
    return p;
  }
  function ecc(data, deg) {
    var g = genPoly(deg), res = new Array(data.length + deg).fill(0);
    for (var i = 0; i < data.length; i++) res[i] = data[i];
    for (i = 0; i < data.length; i++) {
      var f = res[i];
      if (f !== 0) for (var j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
    }
    return res.slice(data.length);
  }

  // ── 버전별 표 (오류정정 M 만) ───────────────────────────────
  //  [총 데이터 코드워드, 블록당 EC 코드워드, 1군 블록수, 1군 데이터, 2군 블록수, 2군 데이터]
  var VER = {
    1: [16,  10, 1, 16, 0, 0],
    2: [28,  16, 1, 28, 0, 0],
    3: [44,  26, 1, 44, 0, 0],
    4: [64,  18, 2, 32, 0, 0],
    5: [86,  24, 2, 43, 0, 0],
    6: [108, 16, 4, 27, 0, 0]
  };
  // 정렬 패턴 중심 (버전 2~6 은 하나뿐 — 나머지는 파인더와 겹쳐 생략된다)
  var ALIGN = { 1: 0, 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };

  function pickVersion(len) {
    for (var v = 1; v <= 6; v++) {
      // 머리 12비트(모드 4 + 길이 8) + 본문
      if (VER[v][0] * 8 >= 12 + len * 8) return v;
    }
    return 0;
  }

  // ── 비트 스트림 → 코드워드 ──────────────────────────────────
  function makeCodewords(bytes, v) {
    var cap = VER[v][0], bits = [];
    function put(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    put(4, 4);                       // 바이트 모드
    put(bytes.length, 8);            // 버전 1~9 는 길이가 8비트
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    // 종단자 — 남은 자리가 4비트보다 적으면 그만큼만
    var rest = cap * 8 - bits.length;
    put(0, Math.min(4, rest));
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      cw.push(b);
    }
    // 채움 코드워드는 236, 17 을 번갈아
    var pad = [0xEC, 0x11], k = 0;
    while (cw.length < cap) cw.push(pad[k++ % 2]);
    return cw;
  }

  // 블록으로 나누고 데이터·EC 를 규격대로 섞는다
  function interleave(cw, v) {
    var t = VER[v], ecLen = t[1];
    var groups = [];
    var at = 0, i;
    for (i = 0; i < t[2]; i++) { groups.push(cw.slice(at, at + t[3])); at += t[3]; }
    for (i = 0; i < t[4]; i++) { groups.push(cw.slice(at, at + t[5])); at += t[5]; }
    var eccs = groups.map(function (g) { return ecc(g, ecLen); });

    var out = [], maxD = Math.max.apply(null, groups.map(function (g) { return g.length; }));
    for (i = 0; i < maxD; i++) {
      for (var b = 0; b < groups.length; b++) if (i < groups[b].length) out.push(groups[b][i]);
    }
    for (i = 0; i < ecLen; i++) {
      for (b = 0; b < eccs.length; b++) out.push(eccs[b][i]);
    }
    return out;
  }

  // ── 바탕 그리기 ─────────────────────────────────────────────
  function blank(n) {
    var m = [], r;
    for (r = 0; r < n; r++) m.push(new Array(n).fill(null));   // null = 아직 안 정함
    return m;
  }
  function finder(m, r, c) {
    for (var i = -1; i <= 7; i++) for (var j = -1; j <= 7; j++) {
      var rr = r + i, cc = c + j;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      var on = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
               (j >= 0 && j <= 6 && (i === 0 || i === 6)) ||
               (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      m[rr][cc] = on ? 1 : 0;
    }
  }
  function alignPat(m, r, c) {
    for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) {
      m[r + i][c + j] = (Math.max(Math.abs(i), Math.abs(j)) !== 1) ? 1 : 0;
    }
  }

  function build(v, data) {
    var n = 21 + 4 * (v - 1), m = blank(n), i, j;
    finder(m, 0, 0); finder(m, 0, n - 7); finder(m, n - 7, 0);
    if (ALIGN[v]) alignPat(m, ALIGN[v], ALIGN[v]);
    for (i = 8; i < n - 8; i++) {                    // 타이밍
      m[6][i] = m[i][6] = (i % 2 === 0) ? 1 : 0;
    }
    m[n - 8][8] = 1;                                 // 언제나 검은 칸
    // 형식 정보 자리를 미리 막아 둔다(값은 나중에)
    for (i = 0; i <= 8; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
    for (i = n - 8; i < n; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }

    // 어디가 자료 칸인지 표시해 둔다(형식 자리는 자료가 아니다)
    var free = [];
    for (i = 0; i < n; i++) { free.push(new Array(n).fill(false)); }
    var reserved = blank(n);
    finder(reserved, 0, 0); finder(reserved, 0, n - 7); finder(reserved, n - 7, 0);
    if (ALIGN[v]) alignPat(reserved, ALIGN[v], ALIGN[v]);
    for (i = 8; i < n - 8; i++) { reserved[6][i] = 1; reserved[i][6] = 1; }
    reserved[n - 8][8] = 1;
    for (i = 0; i <= 8; i++) { reserved[8][i] = 1; reserved[i][8] = 1; }
    for (i = n - 8; i < n; i++) { reserved[8][i] = 1; reserved[i][8] = 1; }

    // 지그재그로 자료를 넣는다. 6번 열(타이밍)은 건너뛴다.
    var bitIdx = 0;
    var bitsAll = [], order = [];
    for (i = 0; i < data.length; i++) for (j = 7; j >= 0; j--) bitsAll.push((data[i] >> j) & 1);
    var up = true;
    for (var col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var t = 0; t < n; t++) {
        var row = up ? (n - 1 - t) : t;
        for (var s = 0; s < 2; s++) {
          var cc = col - s;
          if (reserved[row][cc] !== null) continue;      // 이미 쓰인 자리
          m[row][cc] = bitIdx < bitsAll.length ? bitsAll[bitIdx++] : 0;
          free[row][cc] = true;
          order.push([row, cc]);
        }
      }
      up = !up;
    }
    return { m: m, n: n, free: free, order: order };
  }

  // ── 마스크 ──────────────────────────────────────────────────
  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r)    { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  function penalty(m) {
    var n = m.length, p = 0, i, j, k, run, dark = 0;
    // 규칙 1 — 같은 색 5칸 이상
    for (i = 0; i < n; i++) {
      run = 1;
      for (j = 1; j < n; j++) {
        if (m[i][j] === m[i][j - 1]) { run++; } else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
      run = 1;
      for (j = 1; j < n; j++) {
        if (m[j][i] === m[j - 1][i]) { run++; } else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    // 규칙 2 — 2×2 같은 색
    for (i = 0; i < n - 1; i++) for (j = 0; j < n - 1; j++) {
      var a = m[i][j];
      if (a === m[i][j + 1] && a === m[i + 1][j] && a === m[i + 1][j + 1]) p += 3;
    }
    // 규칙 3 — 1:1:3:1:1 무늬
    var pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    function match(get, len) {
      var c = 0;
      for (var s = 0; s + 11 <= len; s++) {
        var ok1 = true, ok2 = true;
        for (var t = 0; t < 11; t++) {
          var vv = get(s + t);
          if (vv !== pat1[t]) ok1 = false;
          if (vv !== pat2[t]) ok2 = false;
        }
        if (ok1) c++;
        if (ok2) c++;
      }
      return c;
    }
    for (i = 0; i < n; i++) {
      p += 40 * match(function (x) { return m[i][x]; }, n);
      p += 40 * match(function (x) { return m[x][i]; }, n);
    }
    // 규칙 4 — 검은 칸 비율
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (m[i][j]) dark++;
    var pct = dark * 100 / (n * n);
    p += 10 * Math.floor(Math.abs(pct - 50) / 5);
    return p;
  }

  // 형식 정보 — BCH(15,5), 오류정정 M 은 00
  function formatBits(mask) {
    var d = (0 << 3) | mask;          // M = 00
    var r = d << 10;
    for (var i = 14; i >= 10; i--) if ((r >> i) & 1) r ^= 0x537 << (i - 10);
    return ((d << 10) | r) ^ 0x5412;
  }
  // ⚠️ 여기는 행·열을 뒤집기 쉽다. 실제로 처음에 통째로 뒤집혀 있었고,
  //    그 결과 디코더가 마스크·오류정정 수준을 못 읽어 **아무 QR 도 안 읽혔다**.
  //    자료·EC·배치순서가 다 맞아도 여기가 틀리면 그냥 못 읽는 그림이 된다.
  //    사본 1 은 왼쪽 위 파인더를 감싸고(세로 먼저), 사본 2 는 오른쪽 위(가로)와
  //    왼쪽 아래(세로)로 갈라진다.
  function putFormat(m, mask) {
    var n = m.length, f = formatBits(mask), i;

    // 사본 1 — 8번 열의 위쪽(0~5행), 그리고 8번 행의 왼쪽
    for (i = 0; i <= 5; i++) m[i][8] = (f >> i) & 1;
    m[7][8] = (f >> 6) & 1;
    m[8][8] = (f >> 7) & 1;
    m[8][7] = (f >> 8) & 1;
    for (i = 9; i <= 14; i++) m[8][14 - i] = (f >> i) & 1;

    // 사본 2 — 8번 행의 오른쪽 끝(가로), 8번 열의 아래쪽(세로)
    for (i = 0; i <= 7; i++) m[8][n - 1 - i] = (f >> i) & 1;
    for (i = 8; i <= 14; i++) m[n - 15 + i][8] = (f >> i) & 1;

    m[n - 8][8] = 1;                       // 언제나 검은 칸
  }

  function copy(m) { return m.map(function (r) { return r.slice(); }); }

  // ── 바깥에 내주는 것 ────────────────────────────────────────
  // text → 0/1 이 든 2차원 배열
  function matrix(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c > 255) throw new Error("QR: ASCII 만 넣을 수 있어요.");
      bytes.push(c);
    }
    var v = pickVersion(bytes.length);
    if (!v) throw new Error("QR: 주소가 너무 길어요.");
    var data = interleave(makeCodewords(bytes, v), v);
    var b = build(v, data);

    var best = null, bestScore = Infinity;
    for (var k = 0; k < 8; k++) {
      var mm = copy(b.m);
      for (var r = 0; r < b.n; r++) for (var c = 0; c < b.n; c++) {
        if (b.free[r][c] && MASKS[k](r, c)) mm[r][c] ^= 1;
      }
      putFormat(mm, k);
      var s = penalty(mm);
      if (s < bestScore) { bestScore = s; best = mm; }
    }
    return best;
  }

  // 화면에 넣을 SVG. quiet zone 4칸은 규격이 요구한다 — 빼면 잘 안 읽힌다.
  function svg(text, opt) {
    opt = opt || {};
    var m = matrix(text), n = m.length, q = opt.quiet == null ? 4 : opt.quiet;
    var size = n + q * 2, d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (m[r][c]) d += "M" + (c + q) + " " + (r + q) + "h1v1h-1z";
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size +
      '" shape-rendering="crispEdges" width="100%" role="img" aria-label="참여 QR 코드">' +
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
      '<path d="' + d + '" fill="#000"/></svg>';
  }

  // 검사용 — 어떤 버전·마스크를 골랐는지 알려 준다(test/qr_check.py 가 쓴다).
  function debug(text, forceMask) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i));
    var v = pickVersion(bytes.length);
    var data = interleave(makeCodewords(bytes, v), v);
    var b = build(v, data), scores = [], masked = [];
    for (var k = 0; k < 8; k++) {
      var mm = copy(b.m);
      for (var r = 0; r < b.n; r++) for (var c = 0; c < b.n; c++) {
        if (b.free[r][c] && MASKS[k](r, c)) mm[r][c] ^= 1;
      }
      putFormat(mm, k);
      scores.push(penalty(mm));
      masked.push(mm);
    }
    var best = scores.indexOf(Math.min.apply(null, scores));
    return { version: v, mask: best, scores: scores, order: b.order,
             codewords: makeCodewords(bytes, v), interleaved: data,
             matrix: forceMask == null ? masked[best] : masked[forceMask] };
  }

  var api = { matrix: matrix, svg: svg, debug: debug };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.QZ_QR = api;
})();
