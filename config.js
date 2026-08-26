// ────────────────────────────────────────────────────────────
//  여기 두 줄만 채우면 된다. (README.md 3단계)
//
//  Supabase > 프로젝트 > Settings > API 에서
//    Project URL      → url
//    Project API keys > anon public → anonKey
//
//  ⚠️ anon 키가 브라우저에 보이는 것은 **정상이다**(Supabase 설계).
//     이 키로는 테이블을 못 만진다 — schema.sql 이 연 함수 15개만 부를 수 있다.
//  ⚠️ service_role 키는 절대 여기에 넣지 마라. 모든 테이블이 통째로 열린다.
// ────────────────────────────────────────────────────────────
window.QZ = {
  url: "PASTE_PROJECT_URL",
  anonKey: "PASTE_ANON_KEY",
};
