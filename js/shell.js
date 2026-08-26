/**
 * 공용 껍데기 — 화면 전환 · 서버 호출 · 저장소 · 실시간 소켓.
 *
 * ★ 소켓 코드를 **여기 한 벌만** 둔다.
 *   원에듀는 같은 소켓 코드를 네 곳에 복사해 두었고, 그중 한 곳에서
 *   재연결 첫 줄의 정리를 빠뜨려 "구 소켓의 onclose 가 새 소켓을 지우는" 사고가 났다.
 *   한 벌이면 그 사고가 원천적으로 안 난다.
 *
 * ★ 실시간의 원칙: **서버가 정본, 브로드캐스트는 신호일 뿐.**
 *   소켓으로 무엇이 오든 페이로드를 읽지 않고 서버에 다시 묻는다.
 *   페이로드를 믿으면 한 번 놓친 학생이 영원히 대기 화면에 갇힌다.
 */
(function () {
  "use strict";

  var CFG = window.QZ || {};

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── 저장소 ─────────────────────────────────────────────────
  // 사생활 보호 모드에서는 localStorage 접근 자체가 예외를 던진다.
  // 그때 조용히 죽지 않도록 메모리로 물러선다(그 세션 안에서는 정상 동작).
  var mem = {};
  function getItem(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function setItem(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function delItem(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "m" + Date.now() + "-" + Math.random().toString(16).slice(2) +
           Math.random().toString(16).slice(2);
  }

  // 학생 신원. 새로고침해도 같은 사람으로 이어진다.
  function guestKey() {
    var k = getItem("qz_guest");
    if (!k) { k = uuid() + uuid().slice(0, 8); setItem("qz_guest", k); }
    return k;
  }

  // ── 진행자 토큰 ─────────────────────────────────────────────
  // 로그인 대신 쓰는 **비밀번호나 마찬가지**인 긴 무작위 값이다.
  // ⚠️ 만료는 '유휴' 기준이어야 한다. 발급 시각으로 재면 긴 수업 도중
  //    갑자기 '진행 권한이 없어요'로 막힌다.
  var HOST_KEEP_MS = 1000 * 60 * 60 * 12;   // 12시간 유휴
  function hostToken(make) {
    var raw = getItem("qz_host");
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && s.t && s.at && Date.now() - s.at < HOST_KEEP_MS) return s.t;
      } catch (e) { /* 깨진 값은 버린다 */ }
    }
    if (!make) return "";
    var t = (uuid() + uuid()).replace(/-/g, "");   // 64자
    setItem("qz_host", JSON.stringify({ t: t, at: Date.now() }));
    return t;
  }
  function touchToken() {
    var t = hostToken(false);
    if (t) setItem("qz_host", JSON.stringify({ t: t, at: Date.now() }));
  }

  // ── 서버 호출 ───────────────────────────────────────────────
  function rpc(fn, args) {
    if (!CFG.url || String(CFG.url).indexOf("PASTE_") === 0) {
      return Promise.reject(new Error("config.js 를 아직 안 채웠어요. README 3단계를 보세요."));
    }
    return fetch(CFG.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CFG.anonKey,
        Authorization: "Bearer " + CFG.anonKey,
      },
      body: JSON.stringify(args || {}),
    }).then(function (r) {
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { /* 평문 오류 */ }
        if (!r.ok) {
          // Postgres 의 raise exception 은 message 로 온다. 우리가 쓴 한국어가 그대로 나온다.
          throw new Error((data && (data.message || data.hint)) || t || ("오류 " + r.status));
        }
        return data;
      });
    });
  }

  // ── 화면 ────────────────────────────────────────────────────
  function show(name) {
    var vs = document.querySelectorAll(".view");
    for (var i = 0; i < vs.length; i++) {
      vs[i].hidden = vs[i].id !== ("v-" + name);
    }
    window.scrollTo(0, 0);
  }

  function msg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (text ? " " + (kind === "ok" ? "ok" : "bad") : "");
  }

  // ── 실시간 소켓 ─────────────────────────────────────────────
  // onSignal 은 "서버에 다시 물어보라"는 뜻이다. 페이로드는 안 넘긴다 — 일부러다.
  function makeSock(channel, onSignal) {
    var sock = null, hb = null, ref = 0, retried = false, dead = false;

    function drop() {
      if (hb) { clearInterval(hb); hb = null; }
      // ⚠️ onclose 를 먼저 떼야 한다. 안 그러면 CLOSING 상태의 구 소켓이
      //    잠시 뒤 깨어나 **새 소켓의 핸들을 지운다**(중복 구독·하트비트 유실).
      if (sock) { try { sock.onclose = null; sock.close(); } catch (e) {} sock = null; }
    }

    function connect() {
      drop();                                  // ★ 반드시 첫 줄
      if (dead) return;
      var host = String(CFG.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
      if (!host || !channel) return;
      var ws;
      try {
        ws = new WebSocket("wss://" + host + "/realtime/v1/websocket?apikey=" +
                           encodeURIComponent(CFG.anonKey || "") + "&vsn=1.0.0");
      } catch (e) { return; }
      sock = ws;

      ws.onopen = function () {
        ws.send(JSON.stringify({
          topic: "realtime:" + channel, event: "phx_join",
          payload: { config: { broadcast: { self: false } } }, ref: String(++ref)
        }));
        hb = setInterval(function () {
          if (sock && sock.readyState === 1) {
            sock.send(JSON.stringify({ topic: "phoenix", event: "heartbeat",
                                       payload: {}, ref: String(++ref) }));
          }
        }, 25000);
      };

      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.event === "broadcast") onSignal();   // 내용을 안 읽는다. 다시 물어본다.
      };

      ws.onclose = function () {
        if (hb) { clearInterval(hb); hb = null; }
        sock = null;
        if (dead) return;
        // 가려진 탭에서 자주 끊긴다. 한 번은 조용히 되살린다.
        if (!retried) {
          retried = true;
          setTimeout(function () { if (!dead && !sock) { connect(); onSignal(); } }, 1500);
        }
      };
    }

    connect();

    return {
      // 참여자에게 "다시 물어보라"만 보낸다. 내용은 안 싣는다.
      ping: function () {
        if (sock && sock.readyState === 1) {
          sock.send(JSON.stringify({
            topic: "realtime:" + channel, event: "broadcast",
            payload: { type: "broadcast", event: "sync", payload: {} }, ref: String(++ref)
          }));
        }
      },
      wake: function () { retried = false; if (!sock || sock.readyState > 1) connect(); },
      close: function () { dead = true; drop(); },
    };
  }

  // ── 백업 폴링 ───────────────────────────────────────────────
  // ⚠️ 소켓이 살아 있어도 돈다. 상대 쪽 소켓이 잠들면 신호가 **아예 안 나가는데**,
  //    그건 '내 소켓이 멀쩡한가'로는 알 수 없다.
  function makePoll(fn, ms) {
    var id = setInterval(function () { if (!document.hidden) fn(); }, ms || 5000);
    return { stop: function () { clearInterval(id); } };
  }

  window.QZ_SHELL = {
    $: $, esc: esc, rpc: rpc, show: show, msg: msg, uuid: uuid,
    getItem: getItem, setItem: setItem, delItem: delItem,
    guestKey: guestKey, hostToken: hostToken, touchToken: touchToken,
    makeSock: makeSock, makePoll: makePoll,
  };
})();
