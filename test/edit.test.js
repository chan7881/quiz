/**
 * 편집기 순수 함수 검사 — node test/edit.test.js
 *
 * 화면 없이 돌아가는 것만 본다(명렬 파싱 · 유형 전환 · 검증 · 링크 스킴).
 * 여기가 틀리면 수업 도중 저장이 막히거나, 더 나쁘게는 이상한 문항이 저장된다.
 */
"use strict";

// ── 브라우저 흉내 (최소한만) ─────────────────────────────────
globalThis.window = globalThis;
globalThis.document = {
  getElementById: function () { return null; },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
};

require("../js/shell.js");
require("../js/edit.js");
const E = globalThis.QZ_EDIT;

// ── 아주 작은 검사 틀 ────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, "얻음 " + g + " / 바람 " + w);
}

// ── 명렬 파싱 ────────────────────────────────────────────────
console.log("\n[명렬 파싱]");
eq("공백 구분", E.parseRoster("1 김민준"), [{ no: 1, name: "김민준" }]);
eq("쉼표 구분", E.parseRoster("2,이서연"), [{ no: 2, name: "이서연" }]);
eq("마침표 구분", E.parseRoster("3. 박도윤"), [{ no: 3, name: "박도윤" }]);
eq("번호순 정렬", E.parseRoster("5 오\n1 가").map(x => x.no), [1, 5]);
eq("빈 줄·쓰레기 무시", E.parseRoster("\n1 가\n어쩌고\n\n2 나").length, 2);
eq("번호 중복은 첫 것만", E.parseRoster("1 가\n1 나"), [{ no: 1, name: "가" }]);
eq("이름 공백 유지", E.parseRoster("1 김 민 준")[0].name, "김 민 준");
eq("되돌리기", E.rosterText(E.parseRoster("1 가\n2 나")), "1 가\n2 나");

// ── 링크 스킴 ────────────────────────────────────────────────
console.log("\n[링크 스킴 — 여기가 유일한 방어선]");
ok("https 통과", E.safeLink("https://a.com/x.png") !== null);
ok("http 통과", E.safeLink("http://a.com/x.png") !== null);
ok("javascript: 차단", E.safeLink("javascript:alert(1)") === null);
ok("data: 차단", E.safeLink("data:text/html,<script>") === null);
ok("대문자 우회 차단", E.safeLink("JaVaScRiPt:alert(1)") === null);
ok("앞 공백 우회 차단", E.safeLink("  javascript:alert(1)") === null);
ok("빈 값", E.safeLink("") === null);
ok("길이 상한", E.safeLink("https://a.com/" + "x".repeat(600)) === null);
// ★ 변이 검사로 찾은 구멍(2026-08-26). 검사가 '맨 앞'을 안 보면 아래가 통과해 버린다.
//   정규식에서 ^ 를 빼는 순간 이 두 줄이 실패해야 한다 — 실패하지 않으면 검사가 없는 것과 같다.
ok("스킴 뒤에 숨긴 https 차단", E.safeLink("javascript:https://evil.example") === null);
ok("앞에 딴 글자 붙인 것 차단", E.safeLink("data:text/html,https://evil.example") === null);

// ── 유형 전환 ────────────────────────────────────────────────
// ★ 유형을 바꾸면 보기·정답이 그 유형의 기본형으로 **갈아엎여야** 한다.
//   남은 옛 값이 렌더를 터뜨린 것이 원에듀의 실사고다.
console.log("\n[유형 전환 — 옛 값이 남으면 안 된다]");
{
  const it = E.blank();
  E.setKind(it, "slider");
  eq("슬라이더 정답은 {v,tol}", it.answer, { v: 0, tol: 0 });
  eq("슬라이더 범위", it.opts, { min: 0, max: 100 });

  E.setKind(it, "short");
  eq("단답으로 바꾸면 정답이 문자열", it.answer, "");
  ok("단답은 보기가 없다", it.opts === null);

  E.setKind(it, "multi");
  eq("여러개선택 정답은 배열", it.answer, []);
  ok("여러개선택은 보기 배열", Array.isArray(it.opts));

  E.setKind(it, "tf");
  eq("참거짓 보기는 고정", it.opts, ["참", "거짓"]);

  E.setKind(it, "scale");
  eq("규모 기본 범위 1~5", it.opts, { min: 1, max: 5 });
  ok("규모는 정답이 없다", it.answer === null);

  E.setKind(it, "poll");
  ok("설문은 정답이 없다", it.answer === null);

  // 9유형 전부 한 번씩 — 예외 없이 지나가야 한다.
  let allOk = true;
  E.KINDS.forEach(k => {
    try { E.setKind(E.blank(), k.k); } catch (e) { allOk = false; }
  });
  ok("9유형 전환 모두 무사", allOk);
}

// ── 검증 ─────────────────────────────────────────────────────
console.log("\n[저장 전 검증]");
function quiz(over) {
  return Object.assign({
    id: null, title: "3단원 열", speed: false, mode: "nick", roster: [], cur: 0,
    items: [{ kind: "quiz", prompt: "온도란?", media: "", seconds: 20, points: 100,
              opts: ["가", "나", "", ""], answer: 0 }],
  }, over || {});
}
ok("정상 통과", E.validate(quiz()) === null, E.validate(quiz()));
ok("제목 없음", /제목/.test(E.validate(quiz({ title: "  " })) || ""));
ok("문항 0개", /문항이 하나도/.test(E.validate(quiz({ items: [] })) || ""));

{
  const q = quiz(); q.items[0].prompt = "";
  ok("문항 내용 없음", /내용을 적어/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0].opts = ["가", "", "", ""];
  ok("보기 1개면 거절", /두 개 이상/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0].answer = null;
  ok("정답 안 고름", /정답을 골라/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0].media = "javascript:alert(1)";
  ok("나쁜 링크 거절", /http/.test(E.validate(q) || ""));
}
{
  const q = quiz({ mode: "roster", roster: [] });
  ok("명렬인데 명단 없음", /명단/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0] = { kind: "slider", prompt: "몇 도?", media: "",
    seconds: 20, points: 100, opts: { min: 0, max: 100 }, answer: { v: 250, tol: 0 } };
  ok("슬라이더 정답이 범위 밖", /범위 밖/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0] = { kind: "slider", prompt: "몇 도?", media: "",
    seconds: 20, points: 100, opts: { min: 100, max: 0 }, answer: { v: 50, tol: 0 } };
  ok("최소>최대 거절", /최솟값/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0] = { kind: "multi", prompt: "고르기", media: "",
    seconds: 20, points: 100, opts: ["가", "나", "", ""], answer: [] };
  ok("여러개선택 정답 0개 거절", /하나 이상/.test(E.validate(q) || ""));
}
{
  const q = quiz(); q.items[0] = { kind: "short", prompt: "무엇?", media: "",
    seconds: 20, points: 100, opts: null, answer: "  " };
  ok("단답 정답 공백 거절", /정답을 적어/.test(E.validate(q) || ""));
}
{
  // 의견 수집 유형은 정답이 없어도 통과해야 한다.
  const q = quiz(); q.items[0] = { kind: "poll", prompt: "어느 쪽?", media: "",
    seconds: 20, points: 100, opts: ["가", "나", "", ""], answer: null };
  ok("설문은 정답 없이 통과", E.validate(q) === null, E.validate(q));
}
{
  const q = quiz(); q.items[0] = { kind: "open", prompt: "생각을 적어 보자", media: "",
    seconds: 60, points: 0, opts: null, answer: null };
  ok("서술형 통과", E.validate(q) === null, E.validate(q));
}
{
  // 두 번째 문항이 잘못됐으면 번호를 알려 줘야 한다.
  const q = quiz();
  q.items.push({ kind: "quiz", prompt: "", media: "", seconds: 20, points: 100,
                 opts: ["가", "나", "", ""], answer: 0 });
  ok("몇 번 문항인지 알려 줌", /^2번/.test(E.validate(q) || ""), E.validate(q));
}

// ── 마무리 ───────────────────────────────────────────────────
console.log("\n합계: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
