/**
 * 서버 한 바퀴 검사 — node test/e2e.js
 *
 * 진짜 Supabase 를 상대로 교사·학생 흐름을 통째로 돌린다.
 * config.js 의 값을 그대로 쓴다(브라우저가 쓰는 것과 같은 공개 키).
 *
 * ★ 기능이 도는지만 보지 않는다. **새면 안 되는 것이 안 새는지**도 본다:
 *   문항이 열려 있는 동안 정답과 점수판이 나가면 안 된다.
 *
 * 뒷정리까지 한다(만든 퀴즈를 지운다). 남기려면 KEEP=1 을 준다.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// config.js 를 그대로 읽는다 — 두 곳에 값을 두지 않으려는 것.
const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
const window = {};
new Function("window", cfgSrc)(window);
const { url: URL_, anonKey: KEY } = window.QZ;

if (!URL_ || URL_.startsWith("PASTE_")) {
  console.error("config.js 를 아직 안 채웠습니다.");
  process.exit(1);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

async function rpc(fn, args) {
  const head = { "Content-Type": "application/json", apikey: KEY };
  if (/^eyJ/.test(KEY)) head.Authorization = "Bearer " + KEY;   // shell.js 와 같은 규칙
  const r = await fetch(URL_.replace(/\/+$/, "") + "/rest/v1/rpc/" + fn, {
    method: "POST", headers: head, body: JSON.stringify(args || {}),
  });
  const t = await r.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch (e) { /* 평문 */ }
  if (!r.ok) { const e = new Error((d && (d.message || d.hint)) || t || ("오류 " + r.status)); e.status = r.status; throw e; }
  return d;
}
// 거절되어야 하는 호출. 거절되면 메시지를, 통과하면 null 을 준다.
async function rejects(fn, args) {
  try { await rpc(fn, args); return null; } catch (e) { return e.message; }
}

const uuid = () => require("crypto").randomUUID();
const HOST  = (uuid() + uuid()).replace(/-/g, "");     // 64자
const GUEST = uuid() + uuid().slice(0, 8);
const GUEST2 = uuid() + uuid().slice(0, 8);

const ITEMS = [
  { kind: "quiz", prompt: "물이 끓는 온도는?", media: "", seconds: 30, points: 100,
    opts: ["50도", "100도", "150도", "200도"], answer: 1 },
  { kind: "short", prompt: "열이 이동하는 세 가지 방법 중 하나를 적으시오", media: "",
    seconds: 30, points: 100, opts: null, answer: ["전도", "대류", "복사"] },
  { kind: "poll", prompt: "오늘 수업 어땠나요?", media: "", seconds: 20, points: 0,
    opts: ["좋았다", "보통", "어려웠다"], answer: null },
];

(async function main() {
  let quiz = null, run = null;
  try {
    console.log("\n[1] 토큰 검사 — 짧은 토큰은 거절해야 한다");
    ok("32자 미만 거절", !!await rejects("qz_save", { p_token: "short", p_title: "x", p_items: [] }));

    console.log("\n[2] 교사: 퀴즈 저장");
    const saved = await rpc("qz_save", { p_token: HOST, p_quiz: null, p_title: "3단원 열 — 검사",
      p_items: ITEMS, p_speed: true, p_mode: "nick", p_roster: [] });
    quiz = saved.quiz;
    ok("퀴즈 id 반환", !!quiz, saved);

    const list = await rpc("qz_list", { p_token: HOST });
    ok("목록에 보임", list.some(q => q.id === quiz), list);
    ok("문항 수 3", list.find(q => q.id === quiz)?.n === 3);

    console.log("\n[3] 남의 토큰으로는 못 본다");
    const other = (uuid() + uuid()).replace(/-/g, "");
    ok("남의 퀴즈 열람 거절", !!await rejects("qz_get", { p_quiz: quiz, p_token: other }));
    ok("남의 퀴즈 삭제 거절", !!await rejects("qz_del", { p_quiz: quiz, p_token: other }));

    console.log("\n[4] 진행 시작");
    run = await rpc("qz_open", { p_quiz: quiz, p_token: HOST });
    ok("코드 6글자", /^[A-Z2-9]{6}$/.test(run.code), run.code);
    ok("채널이 코드와 다르다(추측 방지)", run.channel && run.channel !== run.code);

    const peek = await rpc("qz_peek", { p_code: run.code });
    ok("코드 조회됨", peek.found === true, peek);
    ok("별명 모드", peek.mode === "nick", peek.mode);

    console.log("\n[5] 학생 참여");
    const j = await rpc("qz_join", { p_code: run.code, p_guest: GUEST, p_nick: "민준" });
    ok("세션 받음", j.session === run.session, j);
    await rpc("qz_join", { p_code: run.code, p_guest: GUEST2, p_nick: "서연" });
    ok("빈 별명 거절", !!await rejects("qz_join", { p_code: run.code, p_guest: uuid(), p_nick: "  " }));

    let s = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("대기 단계", s.phase === "lobby", s.phase);
    ok("참여자 2명", s.players_n === 2, s.players_n);

    console.log("\n[6] ★ 1번 문항 — 정답이 새면 안 된다");
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "question", p_ord: 1 });
    s = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("문항 단계", s.phase === "question" && s.ord === 1, s.phase);
    ok("★ 학생에게 answer 가 없다", s.item && !("answer" in s.item), Object.keys(s.item || {}));
    ok("보기는 보인다", Array.isArray(s.item.opts) && s.item.opts.length === 4);
    ok("★ 분포도 안 준다", (s.dist || []).length === 0, s.dist);
    ok("★ 점수판은 거절", !!await rejects("qz_board", { p_session: run.session, p_guest: GUEST }));
    ok("남은 시간 있음", s.left_ms > 0 && s.left_ms <= 30000, s.left_ms);
    ok("교사는 answer 를 본다",
       (await rpc("qz_host_state", { p_session: run.session, p_token: HOST })).item.answer === 1);

    console.log("\n[7] 답 제출");
    await rpc("qz_answer", { p_session: run.session, p_ord: 1, p_value: 1, p_guest: GUEST });
    await rpc("qz_answer", { p_session: run.session, p_ord: 1, p_value: 0, p_guest: GUEST2 });
    s = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("냈다고 표시됨", s.me && s.me.answered === true, s.me);
    ok("점수가 붙음(속도 가산)", s.me.score > 0 && s.me.score <= 100, s.me.score);
    ok("두 명 제출", s.answered_n === 2, s.answered_n);

    const dup = await rpc("qz_answer", { p_session: run.session, p_ord: 1, p_value: 2, p_guest: GUEST });
    ok("★ 중복 제출은 안 세어짐", dup.counted === false, dup);
    const after = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("★ 점수가 안 변함", after.me.score === s.me.score, [s.me.score, after.me.score]);
    ok("지난 문항 거절", !!await rejects("qz_answer",
        { p_session: run.session, p_ord: 99, p_value: 1, p_guest: GUEST }));
    ok("참여자 아닌 사람 거절", !!await rejects("qz_answer",
        { p_session: run.session, p_ord: 1, p_value: 1, p_guest: uuid() }));

    console.log("\n[8] 공개 · 점수판");
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "reveal" });
    s = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("이제 answer 가 온다", s.item && s.item.answer === 1, s.item && s.item.answer);
    ok("분포가 온다", (s.dist || []).length === 2, s.dist);

    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "board" });
    const b = await rpc("qz_board", { p_session: run.session, p_guest: GUEST, p_top: 10 });
    ok("점수판 2명", (b.top || []).length === 2, b.top);
    ok("맞힌 사람이 1위", b.top[0].name === "민준", b.top);
    ok("내 순위 있음", b.me && b.me.rk === 1, b.me);

    console.log("\n[9] 2번 문항 — 단답 채점(띄어쓰기·복수 정답)");
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "question", p_ord: 2 });
    await rpc("qz_answer", { p_session: run.session, p_ord: 2, p_value: " 대류 ", p_guest: GUEST });
    await rpc("qz_answer", { p_session: run.session, p_ord: 2, p_value: "증발", p_guest: GUEST2 });
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "board" });
    const b2 = await rpc("qz_board", { p_session: run.session, p_guest: GUEST, p_top: 10 });
    const 민준 = b2.top.find(p => p.name === "민준"), 서연 = b2.top.find(p => p.name === "서연");
    ok("공백 있어도 정답 처리", 민준.score > b.top[0].score, [b.top[0].score, 민준.score]);
    ok("틀린 답은 0점 유지", 서연.score === 0, 서연.score);

    console.log("\n[10] 3번 문항 — 설문(정답 없음)");
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "question", p_ord: 3 });
    await rpc("qz_answer", { p_session: run.session, p_ord: 3, p_value: 0, p_guest: GUEST });
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "reveal" });
    s = await rpc("qz_state", { p_session: run.session, p_guest: GUEST });
    ok("설문은 정답이 null", s.item.answer === null, s.item.answer);
    const b3 = await rpc("qz_board", { p_session: run.session, p_guest: GUEST, p_top: 10 });
    ok("설문은 점수를 안 준다",
       b3.top.find(p => p.name === "민준").score === 민준.score, [민준.score, b3.top[0].score]);

    console.log("\n[11] 마무리 · 결과");
    await rpc("qz_phase", { p_session: run.session, p_token: HOST, p_phase: "done" });
    const rep = await rpc("qz_report", { p_session: run.session, p_token: HOST });
    ok("문항 3개 보고", (rep.items || []).length === 3, (rep.items || []).length);
    ok("1번 정답자 1명", rep.items[0].ok === 1, rep.items[0]);
    ok("학생 2명 보고", (rep.players || []).length === 2);
    ok("남이 보고서 못 봄", !!await rejects("qz_report", { p_session: run.session, p_token: other }));

    console.log("\n[12] 종료");
    await rpc("qz_end", { p_session: run.session, p_token: HOST });
    ok("끝난 코드는 안 잡힘", (await rpc("qz_peek", { p_code: run.code })).found === false);
    ok("끝난 세션 조회 시 found:false",
       (await rpc("qz_state", { p_session: run.session, p_guest: GUEST })).found === false);
    run = null;

  } catch (e) {
    fail++;
    console.log("\n★ 중간에 터졌습니다: " + e.message);
    if (e.stack) console.log(e.stack.split("\n").slice(1, 3).join("\n"));
  } finally {
    if (!process.env.KEEP) {
      try { if (run) await rpc("qz_end", { p_session: run.session, p_token: HOST }); } catch (e) {}
      try { if (quiz) { await rpc("qz_del", { p_quiz: quiz, p_token: HOST }); console.log("\n(뒷정리: 검사용 퀴즈 지움)"); } } catch (e) {}
    }
  }

  console.log("\n합계: " + pass + " 통과 / " + fail + " 실패");
  process.exit(fail ? 1 : 0);
})();
