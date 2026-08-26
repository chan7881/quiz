/**
 * 문항 편집기 — 9유형.
 *
 * ⚠️ 두 가지를 어기면 조용히 망가진다. 원에듀가 실사고로 남긴 것이다.
 *   1) **다시 그리기 전에 반드시 sync()**. 안 부르면 선생님이 치던 글자가 사라진다.
 *   2) **유형이 바뀌었으면 sync() 를 거기서 끝낸다.** 아래는 옛 유형의 입력칸을
 *      읽는 코드라, 계속 진행하면 방금 초기화한 answer 를 옛 모양으로 덮어쓴다.
 *      (슬라이더 → 답변 입력 으로 바꾸면 answer 가 {v,tol} 로 덮여 렌더가 터진다)
 */
(function () {
  "use strict";

  var S = window.QZ_SHELL;
  var $ = S.$, esc = S.esc, rpc = S.rpc, msg = S.msg;

  var KINDS = [
    { k: "quiz",   n: "객관식",         g: "지식 확인", opts: true,  ans: "one"  },
    { k: "tf",     n: "진실 또는 거짓",  g: "지식 확인", opts: "tf",  ans: "one"  },
    { k: "multi",  n: "여러 개 선택",    g: "지식 확인", opts: true,  ans: "many" },
    { k: "short",  n: "답변 입력",       g: "지식 확인", opts: false, ans: "text" },
    { k: "slider", n: "슬라이더",        g: "지식 확인", opts: "num", ans: "num"  },
    { k: "poll",   n: "설문 조사",       g: "의견 수집", opts: true,  ans: null   },
    { k: "scale",  n: "규모",           g: "의견 수집", opts: "num", ans: null   },
    { k: "cloud",  n: "단어 클라우드",   g: "의견 수집", opts: false, ans: null   },
    { k: "open",   n: "서술형",         g: "의견 수집", opts: false, ans: null   }
  ];
  var SECS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
  var MARKS = ["가", "나", "다", "라", "마", "바"];

  function def(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i].k === k) return KINDS[i]; return KINDS[0]; }

  // 링크 스킴 검사 — javascript: · data: 를 막는 유일한 자리.
  function safeLink(u) {
    u = String(u == null ? "" : u).trim();
    return /^https?:\/\//i.test(u) && u.length <= 500 ? u : null;
  }

  // ── 문항 만들기 · 유형 바꾸기 ───────────────────────────────
  function blank() {
    return { kind: "quiz", prompt: "", media: "", seconds: 20, points: 100,
             opts: ["", "", "", ""], answer: null };
  }

  // ★ 유형을 바꾸면 보기·정답을 **그 유형의 기본형으로 갈아엎는다.**
  //   남은 옛 값이 렌더를 터뜨린다.
  function setKind(it, k) {
    var d = def(k);
    it.kind = k;
    if (d.opts === "tf")       { it.opts = ["참", "거짓"]; }
    else if (d.opts === "num") { it.opts = (k === "scale") ? { min: 1, max: 5 } : { min: 0, max: 100 }; }
    else if (d.opts === true)  { it.opts = ["", "", "", ""]; }
    else                       { it.opts = null; }

    if (d.ans === "one")       it.answer = null;
    else if (d.ans === "many") it.answer = [];
    else if (d.ans === "text") it.answer = "";
    else if (d.ans === "num")  it.answer = { v: 0, tol: 0 };
    else                       it.answer = null;
  }

  // ── 명렬 ────────────────────────────────────────────────────
  // "1 홍길동" · "1,홍길동" · "1\t홍길동" 을 모두 받는다.
  function parseRoster(text) {
    var out = [], seen = {};
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*(\d{1,3})\s*[.,\t ]\s*(.+?)\s*$/);
      if (!m) return;
      var no = parseInt(m[1], 10);
      if (!no || seen[no]) return;
      seen[no] = 1;
      out.push({ no: no, name: m[2].slice(0, 20) });
    });
    return out.sort(function (a, b) { return a.no - b.no; });
  }
  function rosterText(r) {
    return (r || []).map(function (x) { return x.no + " " + x.name; }).join("\n");
  }

  // ── 화면 값 → 상태 ──────────────────────────────────────────
  function sync(q) {
    if (!q) return;
    var t = $("e-title");  if (t) q.title = t.value;
    var sp = $("e-speed"); if (sp) q.speed = sp.checked;
    var md = $("e-mode");  if (md) q.mode = md.value;
    var rs = $("e-roster");if (rs) q.roster = parseRoster(rs.value);

    var it = q.items[q.cur];
    if (!it) return;

    // 유형과 무관한 것 먼저.
    var p = $("e-prompt");  if (p) it.prompt = p.value;
    var m = $("e-media");   if (m) it.media = m.value;
    var s = $("e-secs");    if (s) it.seconds = parseInt(s.value, 10) || 20;
    var pt = $("e-points"); if (pt) it.points = parseInt(pt.value, 10) || 100;

    // ★ 유형이 바뀌었으면 여기서 끝낸다.
    var kd = $("e-kind");
    if (kd && kd.value !== it.kind) { setKind(it, kd.value); return; }

    var d = def(it.kind);

    if (d.opts === true) {
      var arr = [];
      for (var i = 0; i < 6; i++) {
        var el = $("e-opt-" + i);
        if (el) arr.push(el.value);
      }
      it.opts = arr;
    } else if (d.opts === "num") {
      var mn = $("e-min"), mx = $("e-max");
      it.opts = { min: mn ? (parseFloat(mn.value) || 0) : 0,
                  max: mx ? (parseFloat(mx.value) || 0) : 0 };
    }

    if (d.ans === "text") {
      var a = $("e-ans-t"); if (a) it.answer = a.value;
    } else if (d.ans === "num") {
      var v = $("e-ans-v"), tol = $("e-ans-tol");
      it.answer = { v: v ? (parseFloat(v.value) || 0) : 0,
                    tol: tol ? (parseFloat(tol.value) || 0) : 0 };
    }
    // one · many 는 보기를 눌러서 정한다(입력칸이 아니다).
  }

  // ── 검증 ────────────────────────────────────────────────────
  function validate(q) {
    if (!q.title || !q.title.trim()) return "퀴즈 제목을 적어 주세요.";
    if (!q.items.length) return "문항이 하나도 없어요.";
    if (q.mode === "roster" && !(q.roster || []).length) {
      return "명렬 참여를 골랐으면 학생 명단을 넣어 주세요.";
    }
    for (var i = 0; i < q.items.length; i++) {
      var it = q.items[i], d = def(it.kind), no = (i + 1) + "번 문항: ";
      if (!it.prompt || !it.prompt.trim()) return no + "문항 내용을 적어 주세요.";
      if (it.media && !safeLink(it.media)) return no + "미디어는 http/https 주소만 돼요.";

      if (d.opts === true) {
        var n = (it.opts || []).filter(function (x) { return x && x.trim(); }).length;
        if (n < 2) return no + "보기를 두 개 이상 적어 주세요.";
      }
      if (d.opts === "num" && it.opts && it.opts.min >= it.opts.max) {
        return no + "최솟값이 최댓값보다 작아야 해요.";
      }
      if (d.ans === "one"  && typeof it.answer !== "number") return no + "정답을 골라 주세요.";
      if (d.ans === "many" && !(it.answer || []).length)     return no + "정답을 하나 이상 골라 주세요.";
      if (d.ans === "text" && !String(it.answer || "").trim()) return no + "정답을 적어 주세요.";
      if (d.ans === "num") {
        var a = it.answer || {};
        if (a.v == null || isNaN(a.v)) return no + "정답 숫자를 적어 주세요.";
        if (it.opts && (a.v < it.opts.min || a.v > it.opts.max)) {
          return no + "정답이 최소~최대 범위 밖이에요.";
        }
      }
    }
    return null;
  }

  // ── 그리기 ──────────────────────────────────────────────────
  function optRows(it) {
    var d = def(it.kind), h = "";
    if (d.opts === "tf") {
      h += '<p class="sub" style="margin:10px 0 0">보기는 참·거짓으로 고정돼요.</p>';
    } else if (d.opts === true) {
      h += '<label class="lbl">보기 (빈 칸은 무시돼요)</label>';
      for (var i = 0; i < 6; i++) {
        var v = (it.opts && it.opts[i]) || "";
        if (i >= 4 && !v) continue;                       // 5·6번은 값이 있을 때만
        h += '<div class="row" style="margin-bottom:6px">' +
             '<input id="e-opt-' + i + '" value="' + esc(v) +
             '" placeholder="' + MARKS[i] + '" />' +
             (d.ans ? '<button class="btn small ghost narrow" type="button" data-act="e-ans" data-j="' + i + '">' +
                      (isPicked(it, i) ? "정답 ✓" : "정답으로") + "</button>" : "") +
             "</div>";
      }
      if ((it.opts || []).length < 6) {
        h += '<button class="btn small ghost" type="button" data-act="e-opt-add">보기 칸 늘리기</button>';
      }
    } else if (d.opts === "num") {
      h += '<label class="lbl">범위</label><div class="row">' +
           '<input id="e-min" type="number" value="' + esc(it.opts ? it.opts.min : 0) + '" />' +
           '<span class="narrow" style="text-align:center">~</span>' +
           '<input id="e-max" type="number" value="' + esc(it.opts ? it.opts.max : 100) + '" />' +
           "</div>";
    }
    return h;
  }

  function isPicked(it, j) {
    var d = def(it.kind);
    if (d.ans === "one")  return it.answer === j;
    if (d.ans === "many") return (it.answer || []).indexOf(j) >= 0;
    return false;
  }

  function ansRows(it) {
    var d = def(it.kind);
    if (d.ans === "text") {
      return '<label class="lbl">정답 (여러 개면 줄바꿈으로)</label>' +
             '<textarea id="e-ans-t" placeholder="띄어쓰기·대소문자는 무시하고 채점해요">' +
             esc(typeof it.answer === "string" ? it.answer
                 : (it.answer || []).join("\n")) + "</textarea>";
    }
    if (d.ans === "num") {
      var a = it.answer || {};
      return '<label class="lbl">정답</label><div class="row">' +
             '<input id="e-ans-v" type="number" value="' + esc(a.v == null ? 0 : a.v) + '" />' +
             '<span class="narrow" style="text-align:center">± 오차</span>' +
             '<input id="e-ans-tol" type="number" value="' + esc(a.tol == null ? 0 : a.tol) + '" />' +
             "</div>";
    }
    if (d.ans === null) {
      return '<p class="sub" style="margin:12px 0 0">정답이 없는 유형이에요. ' +
             "점수는 붙지 않고 응답 분포만 보여 줘요.</p>";
    }
    return "";   // one · many 는 보기 옆 단추로 정한다
  }

  function itemChips(q) {
    return '<div class="scroll-x"><div class="row" style="flex-wrap:nowrap;padding-bottom:4px">' +
      q.items.map(function (it, i) {
        return '<button class="btn small ' + (i === q.cur ? "primary" : "ghost") +
          '" type="button" data-act="e-go" data-i="' + i + '">' + (i + 1) + "</button>";
      }).join("") +
      '<button class="btn small ghost" type="button" data-act="e-add">+ 문항</button>' +
      "</div></div>";
  }

  function editHtml(q) {
    var it = q.items[q.cur] || blank();
    var d = def(it.kind);
    var groups = {};
    KINDS.forEach(function (x) { (groups[x.g] = groups[x.g] || []).push(x); });

    return '<div class="card">' +
      '<div class="row"><button class="btn small ghost narrow" type="button" data-act="e-list">← 목록</button>' +
      '<button class="btn small primary narrow" type="button" data-act="e-save">저장</button></div>' +
      '<label class="lbl" for="e-title">퀴즈 제목</label>' +
      '<input id="e-title" value="' + esc(q.title) + '" placeholder="예) 3단원 열 — 형성평가" />' +
      '<label class="lbl">참여 방식</label>' +
      '<select id="e-mode">' +
        '<option value="nick"' + (q.mode === "nick" ? " selected" : "") + '>별명으로 (명단 없이)</option>' +
        '<option value="roster"' + (q.mode === "roster" ? " selected" : "") + '>번호·이름으로 (우리 반 명단)</option>' +
      "</select>" +
      (q.mode === "roster"
        ? '<label class="lbl" for="e-roster">학생 명단 — 한 줄에 «번호 이름»</label>' +
          '<textarea id="e-roster" placeholder="1 김민준&#10;2 이서연&#10;3 박도윤">' +
          esc(rosterText(q.roster)) + "</textarea>" +
          '<p class="sub" style="margin:6px 0 0">' + (q.roster || []).length + "명</p>"
        : "") +
      '<label class="lbl" style="display:flex;gap:8px;align-items:center">' +
        '<input id="e-speed" type="checkbox" style="width:auto;min-height:0"' +
        (q.speed ? " checked" : "") + " /> 빨리 맞힐수록 높은 점수</label>" +
      '<div class="hr"></div>' + itemChips(q) +
      "</div>" +

      '<div class="card">' +
      '<div class="row"><span class="pill on">' + (q.cur + 1) + " / " + q.items.length + "</span>" +
      '<button class="btn small ghost narrow" type="button" data-act="e-up">◀ 앞으로</button>' +
      '<button class="btn small ghost narrow" type="button" data-act="e-down">뒤로 ▶</button>' +
      '<button class="btn small danger narrow" type="button" data-act="e-del">문항 삭제</button></div>' +

      '<label class="lbl" for="e-kind">유형</label><select id="e-kind">' +
      Object.keys(groups).map(function (g) {
        return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (x) {
          return '<option value="' + x.k + '"' + (x.k === it.kind ? " selected" : "") +
                 ">" + esc(x.n) + "</option>";
        }).join("") + "</optgroup>";
      }).join("") + "</select>" +

      '<label class="lbl" for="e-prompt">문항</label>' +
      '<textarea id="e-prompt" placeholder="학생에게 보여 줄 질문">' + esc(it.prompt) + "</textarea>" +

      optRows(it) + ansRows(it) +

      '<label class="lbl" for="e-media">그림·영상 주소 (없으면 비워 두세요)</label>' +
      '<input id="e-media" value="' + esc(it.media || "") + '" placeholder="https://…" />' +

      '<div class="row"><div><label class="lbl" for="e-secs">제한 시간</label>' +
      '<select id="e-secs">' + SECS.map(function (n) {
        return '<option value="' + n + '"' + (n === it.seconds ? " selected" : "") + ">" + n + "초</option>";
      }).join("") + "</select></div>" +
      (d.ans ? '<div><label class="lbl" for="e-points">배점</label>' +
               '<input id="e-points" type="number" min="0" max="1000" value="' +
               esc(it.points == null ? 100 : it.points) + '" /></div>' : "") +
      "</div>" +
      '<p id="e-msg" class="msg"></p>' +
      "</div>";
  }

  function listHtml(list, resume) {
    return (resume || "") +
      '<div class="card"><div class="row">' +
      '<button class="btn small ghost narrow" type="button" data-act="e-home">← 처음</button>' +
      '<button class="btn small primary narrow" type="button" data-act="e-new">+ 새 퀴즈</button>' +
      "</div>" +
      "<h1>내 퀴즈</h1>" +
      '<p class="sub">이 브라우저에만 저장돼요. 다른 기기에서는 안 보입니다.</p>' +
      (list && list.length
        ? '<div class="list">' + list.map(function (q) {
            return '<div class="item"><span class="grow">' +
              '<span class="t">' + esc(q.title) + "</span>" +
              '<span class="d">' + esc(q.n) + "문항 · " +
              (q.mode === "roster" ? "명렬" : "별명") + "</span></span>" +
              '<button class="btn small ghost narrow" type="button" data-act="e-open" data-id="' +
              esc(q.id) + '">편집</button>' +
              '<button class="btn small primary narrow" type="button" data-act="e-run" data-id="' +
              esc(q.id) + '">진행</button></div>';
          }).join("") + "</div>"
        : '<p class="sub" style="margin-top:14px">아직 만든 퀴즈가 없어요.</p>') +
      '<p id="e-msg" class="msg"></p></div>';
  }

  window.QZ_EDIT = {
    KINDS: KINDS, def: def, blank: blank, setKind: setKind, safeLink: safeLink,
    sync: sync, validate: validate, isPicked: isPicked,
    parseRoster: parseRoster, rosterText: rosterText,
    editHtml: editHtml, listHtml: listHtml, MARKS: MARKS,
  };
})();
