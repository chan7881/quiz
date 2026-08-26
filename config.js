// ────────────────────────────────────────────────────────────
//  여기 두 줄만 채우면 된다. (README.md 3단계)
//
//  Supabase > 프로젝트 > Settings > API Keys (또는 Data API)
//    Project URL       → url    ← 끝의 /rest/v1/ 는 빼고 기본 주소만
//    Publishable key   → anonKey
//    (구 프로젝트라면 anon public 키. 둘 다 shell.js 가 받는다)
//
//  ⚠️ 공개 키가 브라우저에 보이는 것은 **정상이다**(Supabase 설계).
//     이 키로는 테이블을 못 만진다 — schema.sql 이 연 함수 15개만 부를 수 있다.
//  ⚠️ service_role · sb_secret_ 키는 절대 여기에 넣지 마라.
//     모든 테이블이 통째로 열린다.
// ────────────────────────────────────────────────────────────
window.QZ = {
  url: "https://gzujnpbwcodppfmwmiwf.supabase.co",
  anonKey: "sb_publishable_fpVXdvQzfCkSZAy_Tm_y4w_LFRHIjJy",
};
