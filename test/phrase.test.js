/**
 * 열쇠 문구 → 열쇠 검사 — node test/phrase.test.js
 *
 * ★ 이 검사가 생긴 이유: «다른 기기에서 같은 문구를 넣었는데 안 열린다» 는 신고.
 *   원인은 **한글 유니코드 정규화**였다. 윈도우 IME 는 NFC(완성형), 맥·iOS 는
 *   NFD(자모 분리)로 넣는데, 눈에는 똑같아 보여도 바이트가 달라 해시가 완전히
 *   달라진다. 같은 브라우저에서만 시험하면 **절대 재현되지 않는다** —
 *   그래서 여기서는 NFD 입력을 일부러 만들어 넣는다.
 */
"use strict";

globalThis.window = globalThis;
globalThis.document = {
  getElementById: function () { return null; },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
};
// node 에도 같은 WebCrypto(crypto.subtle)가 있어서 그대로 쓴다 — 브라우저와 같은 SHA-256.
if (!(globalThis.crypto && globalThis.crypto.subtle)) {
  console.error("이 node 에는 crypto.subtle 이 없습니다. node 18 이상이 필요해요.");
  process.exit(1);
}

require("../js/shell.js");
const S = globalThis.QZ_SHELL;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}

(async function () {
  const P = "우리학교 홍길동 과학 2026";

  console.log("\n[★ 기기가 달라도 같은 열쇠가 나오는가]");
  const nfc = await S.tokenFromPhrase(P.normalize("NFC"));
  const nfd = await S.tokenFromPhrase(P.normalize("NFD"));
  ok("NFC(윈도우) 와 NFD(맥·iOS) 가 같은 열쇠", nfc === nfd, { nfc: nfc.slice(0, 12), nfd: nfd.slice(0, 12) });
  ok("실제로 입력이 서로 달랐다(검사가 헛돌지 않았다)",
     P.normalize("NFC") !== P.normalize("NFD"));

  console.log("\n[사소한 차이는 흡수한다]");
  ok("앞뒤 공백", await S.tokenFromPhrase("  " + P + "  ") === nfc);
  ok("가운데 공백 여러 칸", await S.tokenFromPhrase(P.replace(/ /g, "   ")) === nfc);
  const up = "Our School Hong 2026";
  ok("대소문자", await S.tokenFromPhrase(up.toUpperCase()) === await S.tokenFromPhrase(up.toLowerCase()));

  console.log("\n[달라야 하는 것은 다르게]");
  ok("다른 문구는 다른 열쇠", await S.tokenFromPhrase("우리학교 홍길동 과학 2025") !== nfc);
  ok("한 글자만 달라도 다른 열쇠", await S.tokenFromPhrase("우리학교 홍길동 과학 2026!") !== nfc);
  ok("열쇠는 64자", nfc.length === 64);

  console.log("\n[짧은 문구는 거절]");
  let msg = null;
  try { await S.tokenFromPhrase("짧다"); } catch (e) { msg = e.message; }
  ok("8자 미만 거절", /8자 이상/.test(msg || ""), msg);

  console.log("\n[옛 열쇠도 함께 알려 준다 — 정규화 전에 저장한 퀴즈를 되찾는 길]");
  const pair = await S.phraseTokens(P.normalize("NFD"));
  ok("token 은 정규화한 것", pair.token === nfc);
  ok("legacy 는 그와 다르다(옛 방식)", pair.legacy !== pair.token);
  const pairNfc = await S.phraseTokens(P.normalize("NFC"));
  ok("legacy 는 입력 그대로라 기기마다 다를 수 있다", pairNfc.legacy !== pair.legacy);

  console.log("\n[문구로 정한 열쇠는 만료되지 않는다]");
  S.setHostToken("a".repeat(64), true);
  ok("문구 열쇠로 표시됨", S.isPhraseKey() === true);
  S.setHostToken("b".repeat(64), false);
  ok("자동 열쇠는 표시 안 됨", S.isPhraseKey() === false);

  console.log("\n합계: " + pass + " 통과 / " + fail + " 실패");
  process.exit(fail ? 1 : 0);
})();
