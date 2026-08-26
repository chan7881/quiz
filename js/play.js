/**
 * 학생용 — 코드로 들어와 답하기.
 *
 * ★ 서버(qz_state)가 정본이다. 소켓으로 무엇이 오든 다시 물어본다.
 * ⚠️ answered 는 **잠그기만** 한다(true 로만). 서버가 false 라고 해서 풀면 안 된다 —
 *    보내는 중에 조회가 끼어들면 아직 저장 전이라 false 가 오고, 그 순간 입력칸이
 *    도로 열려 같은 문항에 두 번 답한 것처럼 보인다.
 *    푸는 것은 '문항이 바뀌었다' 와 '제출이 실패했다' 둘뿐이다.
 */
(function () {
  "use strict";

  var S = window.QZ_SHELL, E = window.QZ_EDIT;
  var $ = S.$, esc = S.esc, rpc = S.rpc, msg = S.msg;

  var st = { run: null, pick: null, sent: false, err: null, board: null };
  var sock = null, poll = null, tick = null;
  var peeked = null;                    // qz_peek 결과 (참여 방식·명단)
  var pickedNo = null;

  function errText(e) {
    var m = (e && e.message) || "";
    if (m.indexOf("qz_") >= 0 || (e && (e.code === "PGRST202" || e.code === "PGRST203"))) {
      return "서버 준비가 안 됐어요. 선생님께 알려 주세요.";
    }
    return m || "알 수 없는 오류예요.";
  }

  // ── 첫 화면: 코드 확인 → 별명/번호 ──────────────────────────
  $("hub-next").addEventListener("click", function () {
    var code = String($("hub-code").value || "").trim().toUpperCase();
    if (code.length < 4) { msg($("hub-msg"), "코드를 여섯 글자 넣어 주세요."); return; }

    // 이미 방식을 알고 있으면 이번엔 진짜 참여다.
    if (peeked && peeked.code === code) { join(code); return; }

    var btn = this; btn.disabled = true;
    msg($("hub-msg"), "");
    rpc("qz_peek", { p_code: code })
      .then(function (d) {
        btn.disabled = false;
        if (!d || !d.found) { msg($("hub-msg"), "그런 코드의 퀴즈가 없어요. 다시 확인해 줄래요?"); return; }
        d.code = code;
        peeked = d;
        pickedNo = null;
        drawWho();
        $("hub-next").textContent = "참여하기";
      })
      .catch(function (e) { btn.disabled = false; msg($("hub-msg"), errText(e)); });
  });

  // 코드를 고치면 방식 선택을 접는다 — 다른 퀴즈일 수 있다.
  $("hub-code").addEventListener("input", function () {
    if (!peeked) return;
    peeked = null; pickedNo = null;
    $("hub-who").innerHTML = "";
    $("hub-next").textContent = "다음";
  });

  function drawWho() {
    var box = $("hub-who");
    if (!peeked) { box.innerHTML = ""; return; }

    if (peeked.mode === "roster") {
      var taken = peeked.taken || [];
      box.innerHTML = '<label class="lbl">' + esc(peeked.title) + " — 번호를 골라 주세요</label>" +
        '<div class="nums">' + (peeked.roster || []).map(function (r) {
          var off = taken.indexOf(r.no) >= 0;
          return '<button class="num" type="button" data-no="' + esc(r.no) + '"' +
            (off ? " disabled" : "") + ' aria-pressed="false">' + esc(r.no) + "</button>";
        }).join("") + "</div>" +
        '<p class="sub" style="margin-top:8px">이미 들어온 번호는 고를 수 없어요.</p>';
    } else {
      box.innerHTML = '<label class="lbl" for="hub-nick">' + esc(peeked.title) +
        " — 별명</label>" +
        '<input id="hub-nick" maxlength="20" autocomplete="off" ' +
        'placeholder="교실 화면에 그대로 보여요" />';
      var n = $("hub-nick");
      var last = S.getItem("qz_nick");
      if (last) n.value = last;
      n.focus();
    }
  }

  $("hub-who").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest(".num") : null;
    if (!t || t.disabled) return;
    var all = this.querySelectorAll(".num");
    for (var i = 0; i < all.length; i++) all[i].setAttribute("aria-pressed", "false");
    t.setAttribute("aria-pressed", "true");
    pickedNo = parseInt(t.getAttribute("data-no"), 10);
  });

  function join(code) {
    var args = { p_code: code, p_guest: S.guestKey() };
    if (peeked.mode === "roster") {
      if (!pickedNo) { msg($("hub-msg"), "번호를 골라 주세요."); return; }
      args.p_no = pickedNo;
    } else {
      var nick = String(($("hub-nick") || {}).value || "").trim();
      if (!nick) { msg($("hub-msg"), "별명을 적어 주세요."); return; }
      S.setItem("qz_nick", nick);
      args.p_nick = nick;
    }

    var btn = $("hub-next"); btn.disabled = true;
    rpc("qz_join", args)
      .then(function (d) {
        btn.disabled = false;
        st.run = { session: d.session, channel: d.channel, code: code, phase: "lobby" };
        st.pick = null; st.sent = false; st.err = null; st.board = null;
        // 새로고침 복구용. 탭을 닫으면 사라진다 — '수업 끝났는데 계속 붙어 있다'가 안 생긴다.
        try { sessionStorage.setItem("qz-code", code); } catch (e) { /* 무시 */ }
        S.show("play");
        draw();
        pull();
        sock = S.makeSock(d.channel, pull);
        poll = S.makePoll(function () {
          if (st.run && st.run.phase !== "done") pull();
        }, 5000);
      })
      .catch(function (e) { btn.disabled = false; msg($("hub-msg"), errText(e)); });
  }

  // ── 수명 ────────────────────────────────────────────────────
  function stop() {
    if (sock) { sock.close(); sock = null; }
    if (poll) { poll.stop(); poll = null; }
    if (tick) { clearInterval(tick); tick = null; }
  }
  function leave() {
    stop();
    st.run = null; st.pick = null; st.sent = false; st.err = null; st.board = null;
    try { sessionStorage.removeItem("qz-code"); } catch (e) { /* 무시 */ }
  }

  // ── 상태 ────────────────────────────────────────────────────
  function pull() {
    var run = st.run; if (!run) return;
    rpc("qz_state", { p_session: run.session, p_guest: S.guestKey() })
      .then(function (d) {
        if (!st.run || st.run.session !== run.session) return;      // 그새 나갔다
        // ⚠️ 안내 없이 튕기면 안 된다. 학생은 시상대를 보다가 화면이 사라지고
        //    코드 입력 폼을 마주하게 된다 — '왜 나갔지?' 가 된다.
        if (!d || !d.found) {
          leave(); S.show("hub");
          msg($("hub-msg"), "수업이 끝났어요. 수고했어요!", "ok");
          return;
        }
        var was = st.run.phase, wasOrd = st.run.ord;
        st.run = Object.assign(st.run, d);
        if (d.phase !== was || d.ord !== wasOrd) { st.pick = null; st.sent = false; }
        if (d.me && d.me.answered) st.sent = true;       // ★ 잠그기만 한다
        st.err = null;
        draw();
        timer();
        if ((d.phase === "board" || d.phase === "done") &&
            (!st.board || d.phase !== was || d.ord !== wasOrd)) {
          loadBoard();
        }
      })
      .catch(function (e) { st.err = errText(e); draw(); });
  }

  function loadBoard() {
    var r = st.run; if (!r) return;
    rpc("qz_board", { p_session: r.session, p_guest: S.guestKey(), p_top: 10 })
      .then(function (b) { st.board = b || {}; draw(); })
      .catch(function () { /* question 단계면 거절된다 — 정상 */ });
  }

  function timer() {
    if (tick) { clearInterval(tick); tick = null; }
    var r = st.run;
    if (!r || r.phase !== "question" || r.left_ms == null) return;
    r._left = r.left_ms;
    tick = setInterval(function () {
      if (!st.run || st.run.phase !== "question") { clearInterval(tick); tick = null; return; }
      st.run._left = Math.max(0, (st.run._left || 0) - 250);
      var el = $("p-left");
      if (el) {
        el.textContent = Math.ceil(st.run._left / 1000) + "초";
        el.className = "timer" + (st.run._left <= 5000 ? " low" : "");
      }
      if (st.run._left <= 0) { clearInterval(tick); tick = null; }
    }, 250);
  }

  // ── 그리기 ──────────────────────────────────────────────────
  function optsOf(it) {
    if (!it) return [];
    if (it.kind === "tf") return ["참", "거짓"];
    return Array.isArray(it.opts) ? it.opts.filter(function (x) { return x && String(x).trim(); }) : [];
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

  // 유형별 응답 입력칸.
  function inputHtml(it) {
    var k = it.kind, o = optsOf(it);

    if (k === "quiz" || k === "tf" || k === "poll") {
      return '<div class="opts' + (o.length === 4 ? " four" : "") + '">' +
        o.map(function (x, j) {
          return '<button class="opt" type="button" data-act="p-pick" data-j="' + j + '">' +
            '<span class="mark">' + esc(E.MARKS[j] || (j + 1)) + "</span><span>" +
            esc(x) + "</span></button>";
        }).join("") + "</div>";
    }

    if (k === "multi") {
      var picked = st.pick || [];
      return '<div class="opts' + (o.length === 4 ? " four" : "") + '">' +
        o.map(function (x, j) {
          return '<button class="opt" type="button" data-act="p-toggle" data-j="' + j +
            '" aria-pressed="' + (picked.indexOf(j) >= 0 ? "true" : "false") + '">' +
            '<span class="mark">' + esc(E.MARKS[j] || (j + 1)) + "</span><span>" +
            esc(x) + "</span></button>";
        }).join("") + "</div>" +
        '<button class="btn primary" type="button" data-act="p-send">제출하기</button>';
    }

    if (k === "slider" || k === "scale") {
      var mn = (it.opts && it.opts.min != null) ? it.opts.min : 0;
      var mx = (it.opts && it.opts.max != null) ? it.opts.max : 100;
      var mid = Math.round((mn + mx) / 2);
      return '<label class="lbl" for="p-num">' + esc(mn) + " ~ " + esc(mx) + "</label>" +
        '<input id="p-num" type="range" min="' + esc(mn) + '" max="' + esc(mx) +
        '" value="' + esc(mid) + '" oninput="document.getElementById(\'p-num-v\').textContent=this.value" />' +
        '<p class="timer" id="p-num-v" style="text-align:center">' + esc(mid) + "</p>" +
        '<button class="btn primary" type="button" data-act="p-send">제출하기</button>';
    }

    // short · cloud · open
    return '<label class="lbl" for="p-text">' +
      (k === "open" ? "생각을 적어 주세요" : k === "cloud" ? "떠오르는 낱말" : "답") + "</label>" +
      (k === "open"
        ? '<textarea id="p-text" maxlength="500"></textarea>'
        : '<input id="p-text" maxlength="100" autocomplete="off" />') +
      '<button class="btn primary" type="button" data-act="p-send">제출하기</button>';
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

  function ansLabel(it) {
    var a = it && it.answer, o = optsOf(it);
    if (a == null) return "";
    if (Array.isArray(a)) {
      if (it.kind === "multi") return a.map(function (j) { return o[j]; }).filter(Boolean).join(", ");
      return a.join(" / ");
    }
    if (typeof a === "object") return a.v + (a.tol ? " ± " + a.tol : "");
    if (typeof a === "number" && o[a] != null) return o[a];
    return String(a);
  }

  function boardHtml() {
    var b = st.board || {}, top = b.top || [];
    return '<div class="card"><h2>점수판</h2>' +
      (top.length
        ? top.map(function (p) {
            return '<div class="rank"><span class="rk">' + esc(p.rk) + "</span>" +
              '<span class="nm">' + (p.no != null ? esc(p.no) + " " : "") +
              esc(p.name || "") + "</span>" +
              '<span class="sc">' + esc(p.score) + "점</span></div>";
          }).join("")
        : '<p class="sub">아직 점수가 없어요.</p>') +
      (b.me ? '<p class="sub" style="margin-top:12px">내 순위 <b>' + esc(b.me.rk) +
              "위</b> · " + esc(b.me.score) + "점</p>" : "") +
      '<button class="btn ghost" type="button" data-act="p-exit">나가기</button></div>';
  }

  function draw() {
    var box = $("play-box"), r = st.run;
    if (!box || !r) return;

    if (st.err) {
      box.innerHTML = '<div class="card"><p class="msg bad">' + esc(st.err) + "</p>" +
        '<button class="btn" type="button" data-act="p-retry">다시 시도</button></div>';
      return;
    }

    if (r.phase === "lobby") {
      box.innerHTML = '<div class="card big"><h1>' + esc(r.title || "") + "</h1>" +
        '<p class="sub">들어왔어요' +
        (r.me && r.me.nick ? " · " + esc(r.me.nick) : "") + "</p>" +
        '<p class="sub">선생님이 시작하기를 기다리는 중이에요.</p>' +
        '<button class="btn ghost" type="button" data-act="p-exit">나가기</button></div>';
      return;
    }

    if (r.phase === "question") {
      box.innerHTML = '<div class="card">' +
        '<div class="meta"><span>문항 <b>' + esc(r.ord) + "</b> / " + esc(r.total) + "</span></div>" +
        '<div id="p-left" class="timer">' +
        (r.left_ms != null ? Math.ceil(r.left_ms / 1000) + "초" : "") + "</div>" +
        promptHtml(r.item) +
        (st.sent
          ? '<p class="msg ok" style="margin-top:16px">답을 냈어요. 다음을 기다려 주세요.</p>'
          : inputHtml(r.item)) +
        "</div>";
      return;
    }

    if (r.phase === "reveal") {
      var a = r.item && r.item.answer;
      box.innerHTML = '<div class="card">' + promptHtml(r.item) +
        (a != null
          ? '<p class="msg ok" style="margin-top:10px">정답 · ' + esc(ansLabel(r.item)) + "</p>"
          : "") +
        distHtml(r.item, r.dist) + "</div>";
      return;
    }

    if (r.phase === "board") { box.innerHTML = boardHtml(); return; }

    box.innerHTML = '<div class="card big"><h1>끝났어요</h1>' +
      '<p class="sub">수고했어요!</p></div>' + boardHtml();
  }

  // ── 동작 ────────────────────────────────────────────────────
  $("play-box").addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!t) return;
    var a = t.getAttribute("data-act"), r = st.run;

    if (a === "p-retry") { st.err = null; pull(); return; }
    if (a === "p-exit")  { leave(); S.show("hub"); msg($("hub-msg"), ""); return; }
    if (!r) return;

    if (a === "p-pick") { send(parseInt(t.getAttribute("data-j"), 10)); return; }

    if (a === "p-toggle") {
      var j = parseInt(t.getAttribute("data-j"), 10);
      var picked = st.pick || [];
      var at = picked.indexOf(j);
      if (at >= 0) picked.splice(at, 1); else picked.push(j);
      st.pick = picked;
      draw();
      return;
    }

    if (a === "p-send") {
      var it = (r && r.item) || {}, val = null;
      if (it.kind === "multi") {
        val = (st.pick || []).slice().sort(function (x, y) { return x - y; });
      } else if (it.kind === "slider" || it.kind === "scale") {
        val = parseFloat(($("p-num") || {}).value);
      } else {
        val = String((($("p-text") || {}).value) || "").trim();
      }
      // ⚠️ 빈 값을 그대로 보내면 서버가 원문 오류를 낸다. 여기서 막는다.
      if (val === "" || val == null || (typeof val === "number" && isNaN(val)) ||
          (Array.isArray(val) && !val.length)) {
        window.alert("답을 고르거나 적어 주세요.");
        return;
      }
      send(val);
    }
  });

  function send(value) {
    var r = st.run; if (!r || st.sent) return;
    var ord = r.ord;                    // 이 응답이 **어느 문항의 것인지** 기억해 둔다
    st.sent = true;                     // 화면은 바로 잠근다(서버가 첫 응답을 고정한다)
    draw();
    rpc("qz_answer", { p_session: r.session, p_ord: ord,
                       p_value: value, p_guest: S.guestKey() })
      .catch(function (e) {
        // ⚠️ 늦게 온 실패는 조용히 버린다. 보내는 사이에 선생님이 다음 문항으로 넘기면
        //    서버가 '이미 지난 문항'이라며 거절하는데, 그때 경고창을 띄우면
        //    **방금 뜬 새 문항 위에** 엉뚱한 안내가 덮인다.
        if (!st.run || st.run.ord !== ord) return;
        st.sent = false;
        window.alert(errText(e));
        draw();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !st.run) return;
    if (sock) sock.wake();
    pull();                              // 돌아왔을 때는 반드시 다시 받는다
  });

  // ── 첫 화면의 나머지 단추 ───────────────────────────────────
  $("hub-teacher").addEventListener("click", function () { window.QZ_HOST.enter(); });
  $("brand").addEventListener("click", function () {
    if (st.run && !window.confirm("나갈까요? 진행 중인 퀴즈에서 빠져나옵니다.")) return;
    leave(); S.show("hub");
  });

  // 새로고침 뒤 같은 탭이면 코드를 되찾아 넣어 준다(자동 참여는 하지 않는다).
  try {
    var saved = sessionStorage.getItem("qz-code");
    if (saved) { $("hub-code").value = saved; }
  } catch (e) { /* 무시 */ }
})();
