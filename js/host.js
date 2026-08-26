/**
 * 교사용 — 퀴즈 목록 · 편집 · 진행.
 *
 * ⚠️ 교사 화면은 **빔프로젝터에 뜬다.** 그래서 문항이 열려 있는 동안에는
 *    정답을 화면에 그리지 않는다. 서버는 교사에게 정답을 주지만(qz_host_state),
 *    그리는 것은 '공개' 단계부터다. 데이터가 있다고 그리면 안 되는 자리다.
 */
(function () {
  "use strict";

  var S = window.QZ_SHELL, E = window.QZ_EDIT;
  var $ = S.$, esc = S.esc, rpc = S.rpc, msg = S.msg;

  var st = { list: null, quiz: null, run: null, board: null, rep: null };
  var sock = null, poll = null, tick = null;

  function tok(make) { return S.hostToken(!!make); }

  function errText(e) {
    var m = (e && e.message) || "";
    if (m.indexOf("qz_") >= 0 || (e && (e.code === "PGRST202" || e.code === "PGRST203"))) {
      return "서버 준비가 안 됐어요. sql/schema.sql 을 실행했는지 확인해 주세요.";
    }
    return m || "알 수 없는 오류예요.";
  }

  // ── 수명 ────────────────────────────────────────────────────
  function stopRun() {
    if (sock) { sock.close(); sock = null; }
    if (poll) { poll.stop(); poll = null; }
    if (tick) { clearInterval(tick); tick = null; }
  }
  function leaveRun() { stopRun(); st.run = null; st.board = null; st.rep = null; }

  // ── 목록 ────────────────────────────────────────────────────
  function enter() {
    S.show("edit");
    st.quiz = null;
    drawEdit();
    loadList();
    checkResume();
  }

  function loadList() {
    var t = tok(false);
    if (!t) { st.list = []; drawEdit(); return; }
    rpc("qz_list", { p_token: t })
      .then(function (d) { st.list = d || []; drawEdit(); })
      .catch(function (e) { st.list = []; drawEdit(); msg($("e-msg"), errText(e)); });
  }

  // ⚠️ 자동으로 들어가지 않는다. 눌러야 들어가는 단추만 보여 준다.
  //    지난 시간 열어 둔 것에 갑자기 끌려 들어가면 곤란하다.
  var resumeInfo = null;
  function checkResume() {
    var t = tok(false);
    if (!t) return;
    rpc("qz_resume", { p_token: t }).then(function (d) {
      resumeInfo = (d && d.open) ? d : null;
      drawEdit();
    }).catch(function () { resumeInfo = null; });
  }

  function resumeHtml() {
    if (!resumeInfo) return "";
    return '<div class="card"><h2>진행 중이던 퀴즈</h2>' +
      '<p class="sub">' + esc(resumeInfo.title) + " · 코드 " + esc(resumeInfo.code) + "</p>" +
      '<button class="btn primary" type="button" data-act="e-resume">이어서 진행</button></div>';
  }

  function drawEdit() {
    var box = $("edit-box");
    if (!box) return;
    // 열쇠 상태: 없음(false) · 자동(true) · 문구로 정함("phrase")
    var state = tok(false) ? (S.getItem("qz_host_phrase") ? "phrase" : true) : false;
    box.innerHTML = st.quiz ? E.editHtml(st.quiz)
                            : E.listHtml(st.list, resumeHtml(), state);
  }

  // ── 편집 화면의 단추 ────────────────────────────────────────
  $("edit-box").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!t) return;
    var a = t.getAttribute("data-act"), q = st.quiz;

    if (a === "e-home") { S.show("hub"); return; }

    if (a === "e-resume") {
      if (!resumeInfo) return;
      st.run = { session: resumeInfo.session, code: resumeInfo.code,
                 channel: resumeInfo.channel, phase: resumeInfo.phase };
      startRun();
      return;
    }

    // ── 기기 옮기기 ──
    if (a === "e-key-use") {
      var phrase = ($("e-key-in") || {}).value || "";
      var move = !!(($("e-key-move") || {}).checked);
      var old = tok(false);
      t.disabled = true;
      S.tokenFromPhrase(phrase).then(function (nt) {
        if (nt === old) {
          msg($("e-key-msg"), "이미 그 문구로 되어 있어요.", "ok");
          t.disabled = false; return;
        }
        // 열쇠를 바꾸기 **전에** 옮긴다. 먼저 바꾸면 옛 열쇠를 잃어버린다.
        var step = (move && old)
          ? rpc("qz_reown", { p_old: old, p_new: nt })
          : Promise.resolve({ moved: 0 });
        return step.then(function (d) {
          S.setHostToken(nt);
          S.setItem("qz_host_phrase", "1");
          st.quiz = null; st.list = null;
          drawEdit();
          msg($("e-key-msg"),
              "이 문구로 정했어요." + (d && d.moved ? " 퀴즈 " + d.moved + "개를 옮겼어요." : "") +
              " 다른 기기에서도 같은 문구를 넣으세요.", "ok");
          loadList(); checkResume();
        });
      }).catch(function (e) {
        // ⚠️ qz_reown 이 서버에 없으면 **열쇠를 바꾸지 않고 멈춘다.**
        //    그냥 바꾸면 기존 퀴즈를 못 여는 상태가 되어 더 나쁘다.
        var m = (e && e.message) || "";
        if (m.indexOf("qz_reown") >= 0 || (e && (e.code === "PGRST202" || e.code === "PGRST203"))) {
          m = "서버에 «기기 옮기기» 기능이 아직 없어요. sql/schema.sql 을 다시 한 번 " +
              "실행해 주세요(여러 번 실행해도 안전합니다). 열쇠는 그대로 두었어요.";
        }
        msg($("e-key-msg"), m || "열쇠를 바꾸지 못했어요.");
        t.disabled = false;
      });
      return;
    }

    if (a === "e-new") {
      st.quiz = { id: null, title: "", items: [E.blank()], speed: false,
                  mode: "nick", roster: [], cur: 0 };
      drawEdit(); return;
    }

    if (a === "e-open") {
      var id = t.getAttribute("data-id");
      rpc("qz_get", { p_quiz: id, p_token: tok(false) }).then(function (d) {
        st.quiz = { id: d.id, title: d.title, items: d.items || [], speed: !!d.speed,
                    mode: d.mode, roster: d.roster || [], cur: 0 };
        if (!st.quiz.items.length) st.quiz.items = [E.blank()];
        drawEdit();
      }).catch(function (e) { msg($("e-msg"), errText(e)); });
      return;
    }

    if (a === "e-run") { open(t.getAttribute("data-id"), t); return; }

    if (!q) return;

    if (a === "e-list") { E.sync(q); st.quiz = null; drawEdit(); loadList(); return; }

    if (a === "e-go")   { E.sync(q); q.cur = parseInt(t.getAttribute("data-i"), 10); drawEdit(); return; }
    if (a === "e-add")  { E.sync(q); q.items.push(E.blank()); q.cur = q.items.length - 1; drawEdit(); return; }

    if (a === "e-del") {
      if (q.items.length <= 1) { msg($("e-msg"), "문항이 하나는 있어야 해요."); return; }
      if (!window.confirm("이 문항을 지울까요?")) return;
      E.sync(q); q.items.splice(q.cur, 1);
      q.cur = Math.max(0, Math.min(q.cur, q.items.length - 1));
      drawEdit(); return;
    }

    if (a === "e-opt-add") {
      E.sync(q);
      var it = q.items[q.cur];
      if (Array.isArray(it.opts) && it.opts.length < 6) it.opts.push("");
      drawEdit(); return;
    }

    // 보기를 정답으로 지정.
    if (a === "e-ans") {
      E.sync(q);
      var item = q.items[q.cur], d = E.def(item.kind), j2 = parseInt(t.getAttribute("data-j"), 10);
      if (d.ans === "one") {
        item.answer = (item.answer === j2) ? null : j2;
      } else if (d.ans === "many") {
        var arr = item.answer || [], at = arr.indexOf(j2);
        if (at >= 0) arr.splice(at, 1); else arr.push(j2);
        item.answer = arr;
      }
      drawEdit(); return;
    }

    if (a === "e-save") {
      E.sync(q);
      var bad = E.validate(q);
      if (bad) { msg($("e-msg"), bad); return; }
      t.disabled = true;
      // 단답 정답은 줄바꿈으로 여러 개를 받았다 — 배열로 바꿔 보낸다.
      var items = JSON.parse(JSON.stringify(q.items));
      items.forEach(function (x) {
        if (x.kind === "short" && typeof x.answer === "string") {
          x.answer = x.answer.split(/\r?\n/).map(function (s) { return s.trim(); })
                              .filter(Boolean);
        }
      });
      rpc("qz_save", { p_token: tok(true), p_quiz: q.id, p_title: q.title,
                       p_items: items, p_speed: q.speed,
                       p_mode: q.mode, p_roster: q.roster })
        .then(function (d) {
          q.id = (d && d.quiz) || q.id;
          S.touchToken();
          msg($("e-msg"), "저장했어요.", "ok");
          t.disabled = false;
        })
        .catch(function (e) { msg($("e-msg"), errText(e)); t.disabled = false; });
      return;
    }
  });

  // select 를 바꾸면 화면이 달라진다(유형·참여 방식).
  $("edit-box").addEventListener("change", function (ev) {
    if (!st.quiz) return;
    var id = ev.target && ev.target.id;
    if (id === "e-kind" || id === "e-mode") { E.sync(st.quiz); drawEdit(); }
  });

  // ── 진행 ────────────────────────────────────────────────────
  function open(quizId, btn) {
    if (btn) btn.disabled = true;
    rpc("qz_open", { p_quiz: quizId, p_token: tok(false) }).then(function (d) {
      S.touchToken();
      st.quiz = null;
      st.run = { session: d.session, code: d.code, channel: d.channel, phase: "lobby" };
      startRun();
    }).catch(function (e) {
      window.alert(errText(e));
      if (btn) btn.disabled = false;
    });
  }

  function startRun() {
    S.show("host");
    st.board = null; st.rep = null;
    drawHost();
    pull();
    stopRun();
    sock = S.makeSock(st.run.channel, pull);
    poll = S.makePoll(function () { if (st.run) pull(); }, 5000);
  }

  function pull() {
    var r = st.run; if (!r) return;
    rpc("qz_host_state", { p_session: r.session, p_token: tok(false) })
      .then(function (d) {
        if (!st.run || st.run.session !== r.session) return;
        if (!d || !d.found) { leaveRun(); enter(); return; }
        st.run = Object.assign(st.run, d);
        drawHost();
        timer();
        if ((d.phase === "board" || d.phase === "done") && !st.board) loadBoard();
      })
      .catch(function (e) { msg($("h-msg"), errText(e)); });
  }

  function loadBoard() {
    var r = st.run; if (!r) return;
    rpc("qz_board", { p_session: r.session, p_top: 20 })
      .then(function (b) { st.board = b || {}; drawHost(); })
      .catch(function () { /* question 단계면 거절된다 — 정상 */ });
  }

  function phase(ph, ord) {
    var r = st.run; if (!r) return;
    rpc("qz_phase", { p_session: r.session, p_token: tok(false), p_phase: ph, p_ord: ord })
      .then(function () {
        S.touchToken();
        st.board = null;
        if (sock) sock.ping();          // 학생들에게 "다시 물어보라"
        pull();
        if (ph === "board" || ph === "done") loadBoard();
      })
      .catch(function (e) { window.alert(errText(e)); });
  }

  // 남은 시간은 서버가 준 left_ms 로 시작해 로컬에서 깎는다. 다음 조회에서 다시 맞춘다.
  function timer() {
    if (tick) { clearInterval(tick); tick = null; }
    var r = st.run;
    if (!r || r.phase !== "question" || r.left_ms == null) return;
    r._left = r.left_ms;
    tick = setInterval(function () {
      if (!st.run || st.run.phase !== "question") { clearInterval(tick); tick = null; return; }
      st.run._left = Math.max(0, (st.run._left || 0) - 250);
      var el = $("h-left");
      if (el) {
        el.textContent = Math.ceil(st.run._left / 1000) + "초";
        el.className = "timer" + (st.run._left <= 5000 ? " low" : "");
      }
      if (st.run._left <= 0) { clearInterval(tick); tick = null; }
    }, 250);
  }

  // ── 교사 화면 그리기 ────────────────────────────────────────
  function drawHost() {
    var box = $("host-box"), r = st.run;
    if (!box || !r) return;

    var top = $("top-code");
    if (top) { top.hidden = !r.code; top.textContent = r.code || ""; }

    box.innerHTML = headHtml(r) + bodyHtml(r) + '<p id="h-msg" class="msg"></p>';
  }

  function headHtml(r) {
    return '<div class="card"><div class="row">' +
      '<button class="btn small ghost narrow" type="button" data-act="h-back">← 목록</button>' +
      '<span class="pill on">' + esc(r.title || "") + "</span>" +
      '<button class="btn small danger narrow" type="button" data-act="h-end">수업 끝내기</button>' +
      "</div></div>";
  }

  // 학생이 들어올 주소. 코드가 붙어 있어 찍으면 코드를 칠 필요가 없다.
  function joinUrl(code) {
    var path = location.pathname.replace(/index\.html$/i, "");
    return location.origin + path + "?c=" + encodeURIComponent(code);
  }

  // ⚠️ 학교 와이파이를 믿지 않는다 — QR 은 바깥 라이브러리 없이 js/qr.js 가 그린다.
  //    혹시 그리다 실패해도 코드는 아래에 크게 남으므로 수업은 굴러간다.
  function qrHtml(code) {
    if (!window.QZ_QR) return "";
    try {
      return '<div class="qr">' + window.QZ_QR.svg(joinUrl(code)) + "</div>" +
             '<p class="sub" style="margin:8px 0 0;word-break:break-all">' +
             esc(joinUrl(code)) + "</p>";
    } catch (e) {
      return "";
    }
  }

  function promptHtml(it) {
    var link = E.safeLink(it && it.media);
    var m = link && link.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/i);
    return '<p class="prompt">' + esc((it && it.prompt) || "") + "</p>" +
      (link ? '<div class="media">' + (m
        ? '<iframe src="https://www.youtube.com/embed/' + esc(m[1]) +
          '" title="영상" allowfullscreen loading="lazy"></iframe>'
        : '<img src="' + esc(link) + '" alt="" loading="lazy" />') + "</div>" : "");
  }

  function optsOf(it) {
    if (!it) return [];
    if (it.kind === "tf") return ["참", "거짓"];
    return Array.isArray(it.opts) ? it.opts.filter(function (x) { return x && String(x).trim(); }) : [];
  }

  function ansLabel(it) {
    var a = it && it.answer, o = optsOf(it);
    if (a == null) return "";
    if (Array.isArray(a)) {
      // 단답의 복수 정답은 문자열 배열, 여러 개 선택은 번호 배열이다.
      if (it.kind === "multi") return a.map(function (j) { return o[j]; }).filter(Boolean).join(", ");
      return a.join(" / ");
    }
    if (typeof a === "object") return a.v + (a.tol ? " ± " + a.tol : "");
    if (typeof a === "number" && o[a] != null) return o[a];
    return String(a);
  }

  function distHtml(it, dist) {
    var o = optsOf(it);
    var total = (dist || []).reduce(function (s, d) { return s + (d.n || 0); }, 0);
    if (!total) return '<p class="sub" style="margin-top:12px">응답이 없어요.</p>';
    return '<div class="bars">' + dist.map(function (d) {
      var v = d.v, label;
      if (Array.isArray(v)) label = v.map(function (j) { return o[j] != null ? o[j] : j; }).join(", ");
      else if (typeof v === "number" && o[v] != null) label = o[v];
      else label = String(v);
      return '<div class="bar"><span class="t">' + esc(label) + "</span>" +
        '<span class="n">' + esc(d.n) + "명</span>" +
        '<span class="track"><i style="width:' +
        Math.round(100 * (d.n || 0) / total) + '%"></i></span></div>';
    }).join("") + "</div>";
  }

  function boardHtml() {
    var b = st.board || {}, top = b.top || [];
    if (!top.length) return '<p class="sub">아직 점수가 없어요.</p>';
    return top.map(function (p) {
      return '<div class="rank"><span class="rk">' + esc(p.rk) + "</span>" +
        '<span class="nm">' + (p.no != null ? esc(p.no) + " " : "") + esc(p.name || "") + "</span>" +
        '<span class="sc">' + esc(p.score) + "점</span></div>";
    }).join("");
  }

  function bodyHtml(r) {
    // ── 대기 ──
    if (r.phase === "lobby") {
      return '<div class="card big">' +
        '<p class="sub">폰 카메라로 찍거나, 코드를 넣어 들어오세요</p>' +
        qrHtml(r.code) +
        '<div class="code">' + esc(r.code) + "</div>" +
        '<p class="sub" style="margin-top:14px">들어온 사람 <b>' + esc(r.players_n || 0) + "</b>명</p>" +
        (r.players && r.players.length
          ? '<p class="sub" style="overflow-wrap:anywhere">' +
            r.players.map(function (p) {
              return esc((p.no != null ? p.no + " " : "") + (p.name || ""));
            }).join(" · ") + "</p>"
          : "") +
        '<button class="btn primary" type="button" data-act="h-start">시작하기</button>' +
        "</div>";
    }

    // ── 문항 진행 중 ──
    // ⚠️ 정답을 그리지 않는다. 이 화면은 교실 앞에 떠 있다.
    if (r.phase === "question") {
      var o = optsOf(r.item);
      return '<div class="card">' +
        '<div class="meta"><span>문항 <b>' + esc(r.ord) + "</b> / " + esc(r.total) + "</span>" +
        '<span>제출 <b>' + esc(r.answered_n || 0) + "</b> / " + esc(r.players_n || 0) + "명</span></div>" +
        '<div id="h-left" class="timer">' +
        (r.left_ms != null ? Math.ceil(r.left_ms / 1000) + "초" : "") + "</div>" +
        promptHtml(r.item) +
        (o.length ? '<div class="opts' + (o.length === 4 ? " four" : "") + '">' +
          o.map(function (x, j) {
            return '<div class="opt"><span class="mark">' + esc(E.MARKS[j] || (j + 1)) +
              "</span><span>" + esc(x) + "</span></div>";
          }).join("") + "</div>" : "") +
        '<button class="btn primary" type="button" data-act="h-reveal">답 공개하기</button>' +
        "</div>";
    }

    // ── 공개 ──
    if (r.phase === "reveal") {
      var oo = optsOf(r.item), a = r.item && r.item.answer;
      return '<div class="card">' +
        '<div class="meta"><span>문항 <b>' + esc(r.ord) + "</b> / " + esc(r.total) + "</span></div>" +
        promptHtml(r.item) +
        (a != null
          ? '<p class="sub" style="margin-top:10px;color:var(--ok);font-weight:700">정답 · ' +
            esc(ansLabel(r.item)) + "</p>"
          : '<p class="sub" style="margin-top:10px">정답이 없는 유형이에요.</p>') +
        distHtml(r.item, r.dist) +
        '<button class="btn primary" type="button" data-act="h-board">점수판 보기</button>' +
        "</div>";
    }

    // ── 점수판 ──
    if (r.phase === "board") {
      return '<div class="card"><h2>점수판</h2>' + boardHtml() +
        '<button class="btn primary" type="button" data-act="h-next">' +
        (r.ord >= r.total ? "마치기" : "다음 문항") + "</button></div>";
    }

    // ── 끝 ──
    return '<div class="card"><h2>최종 점수</h2>' + boardHtml() +
      '<button class="btn ghost" type="button" data-act="h-report">결과 자세히 보기</button>' +
      "</div>" + (st.rep ? reportHtml(st.rep) : "");
  }

  function reportHtml(d) {
    return '<div class="card"><h2>문항별</h2><div class="scroll-x"><table>' +
      "<tr><th>번호</th><th>문항</th><th class='n'>응답</th><th class='n'>정답</th></tr>" +
      (d.items || []).map(function (x) {
        // ⚠️ 의견 수집 유형은 정답이 없다. 여기서 0 을 그대로 찍으면
        //    '아무도 못 맞혔다'로 읽힌다 — 아예 해당 없음(—)으로 둔다.
        var scored = !!(E.def(x.kind) || {}).ans;
        return "<tr><td>" + esc(x.ord) + "</td><td>" + esc(x.prompt || "") +
          "</td><td class='n'>" + esc(x.n) + "</td><td class='n'>" +
          (scored && x.ok != null ? esc(x.ok) : "—") + "</td></tr>";
      }).join("") + "</table></div>" +
      "<h2 style='margin-top:18px'>학생별</h2><div class='scroll-x'><table>" +
      "<tr><th>번호</th><th>이름</th><th class='n'>맞힌 수</th><th class='n'>점수</th></tr>" +
      (d.players || []).map(function (p) {
        return "<tr><td>" + (p.no == null ? "—" : esc(p.no)) + "</td><td>" +
          esc(p.name || "") + "</td><td class='n'>" + esc(p.ok) +
          "</td><td class='n'>" + esc(p.score) + "</td></tr>";
      }).join("") + "</table></div></div>";
  }

  // ── 진행 화면의 단추 ────────────────────────────────────────
  $("host-box").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!t) return;
    var a = t.getAttribute("data-act"), r = st.run;
    if (!r) return;

    if (a === "h-back")   { leaveRun(); hideCode(); enter(); return; }
    if (a === "h-start")  { phase("question", 1); return; }
    if (a === "h-reveal") { phase("reveal", null); return; }
    if (a === "h-board")  { phase("board", null); return; }
    if (a === "h-next")   {
      if (r.ord >= r.total) phase("done", null);
      else phase("question", r.ord + 1);
      return;
    }
    if (a === "h-report") {
      rpc("qz_report", { p_session: r.session, p_token: tok(false) })
        .then(function (d) { st.rep = d; drawHost(); })
        .catch(function (e) { msg($("h-msg"), errText(e)); });
      return;
    }
    if (a === "h-end") {
      if (!window.confirm("수업을 끝낼까요? 학생 화면이 닫히고 코드가 사라져요.")) return;
      rpc("qz_end", { p_session: r.session, p_token: tok(false) })
        .then(function () { leaveRun(); hideCode(); enter(); })
        .catch(function (e) { msg($("h-msg"), errText(e)); });
      return;
    }
  });

  function hideCode() { var t = $("top-code"); if (t) { t.hidden = true; t.textContent = ""; } }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !st.run) return;
    if (sock) sock.wake();
    pull();                              // 돌아왔을 때는 반드시 다시 받는다
  });

  window.QZ_HOST = { enter: enter };
})();
