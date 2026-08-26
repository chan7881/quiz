-- ============================================================
--  수업용 실시간 퀴즈 — 스키마 + RPC
--  Supabase > SQL Editor 에 통째로 붙여넣고 Run 하면 끝난다.
--  다시 실행해도 안전하다(전부 create or replace / if not exists).
--
--  ★ 설계 원칙
--   1) 브라우저는 테이블을 못 만진다. 아래 함수 15개만 부를 수 있다.
--   2) 문항이 열려 있는 동안 서버는 **정답도 점수판도 안 준다** — 새면 끝이다.
--   3) 실시간 신호(Broadcast)는 "다시 물어보라"는 뜻일 뿐,
--      화면의 정본은 언제나 qz_state() 다.
-- ============================================================

create extension if not exists pgcrypto;

-- ── 테이블 ──────────────────────────────────────────────────

create table if not exists qz_quizzes (
  id          uuid primary key default gen_random_uuid(),
  owner_token text        not null,
  title       text        not null default '새 퀴즈',
  items       jsonb       not null default '[]'::jsonb,
  speed       boolean     not null default false,
  join_mode   text        not null default 'nick'
              check (join_mode in ('nick','roster')),
  roster      jsonb       not null default '[]'::jsonb,   -- [{no,name}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists qz_quizzes_owner on qz_quizzes(owner_token, updated_at desc);

-- 한 번의 진행(수업 1회분).
-- ⚠️ 퀴즈 내용을 **복사해 둔다**. 진행 중에 편집기에서 문항을 고쳐도
--    돌고 있는 수업이 흔들리면 안 된다.
create table if not exists qz_sessions (
  id          uuid primary key default gen_random_uuid(),
  quiz_id     uuid        references qz_quizzes(id) on delete set null,
  host_token  text        not null,
  code        text        not null,
  channel     text        not null default replace(gen_random_uuid()::text,'-',''),
  phase       text        not null default 'lobby'
              check (phase in ('lobby','question','reveal','board','done')),
  ord         int,
  q_opened_at timestamptz,
  title       text        not null,
  items       jsonb       not null,
  speed       boolean     not null,
  join_mode   text        not null,
  roster      jsonb       not null,
  ended_at    timestamptz,
  created_at  timestamptz not null default now()
);
-- 코드는 **살아 있는 세션 사이에서만** 유일하다. 끝나면 재사용된다(6글자를 오래 쓰려고).
create unique index if not exists qz_sessions_live_code
  on qz_sessions(code) where ended_at is null;
create index if not exists qz_sessions_host on qz_sessions(host_token, created_at desc);

create table if not exists qz_players (
  session_id uuid        not null references qz_sessions(id) on delete cascade,
  guest_key  text        not null,
  nick       text,
  no         int,
  name       text,
  score      int         not null default 0,
  joined_at  timestamptz not null default now(),
  primary key (session_id, guest_key)
);
-- 명렬 모드에서 한 번호를 두 사람이 못 쓰게.
create unique index if not exists qz_players_no
  on qz_players(session_id, no) where no is not null;

create table if not exists qz_answers (
  session_id uuid        not null references qz_sessions(id) on delete cascade,
  ord        int         not null,
  guest_key  text        not null,
  value      jsonb       not null,
  correct    boolean,
  ms         int,
  points     int         not null default 0,
  created_at timestamptz not null default now(),
  -- ★ 첫 응답만 남는다. 중복 제출이 DB 수준에서 막힌다.
  primary key (session_id, ord, guest_key)
);

-- ── 잠금 ────────────────────────────────────────────────────
-- RLS 를 켜고 정책을 **하나도 안 만든다** → anon 은 테이블에 접근 불가.
-- 아래 함수들은 security definer 라 소유자 권한으로 우회한다.
alter table qz_quizzes  enable row level security;
alter table qz_sessions enable row level security;
alter table qz_players  enable row level security;
alter table qz_answers  enable row level security;

revoke all on qz_quizzes, qz_sessions, qz_players, qz_answers from anon, authenticated;

-- ── 잔가지 ──────────────────────────────────────────────────

-- 헷갈리는 글자(I,O,0,1) 를 뺀 6글자. 교실에서 불러 주기 좋아야 한다.
create or replace function qz_gen_code() returns text
language plpgsql volatile as $fn$
declare
  al text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c  text;
  i  int;
  n  int := 0;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(al, 1 + floor(random()*length(al))::int, 1);
    end loop;
    exit when not exists (select 1 from qz_sessions s
                          where s.code = c and s.ended_at is null);
    n := n + 1;
    if n > 50 then raise exception '코드를 만들지 못했어요. 다시 시도해 주세요.'; end if;
  end loop;
  return c;
end $fn$;

-- 단답 비교용 정규화: 공백 전부 제거 + 소문자.
create or replace function qz_norm(s text) returns text
language sql immutable as $fn$
  select lower(regexp_replace(coalesce(s,''), '\s', '', 'g'))
$fn$;

-- 채점. 정답이 없는 유형(의견 수집)은 null 을 준다 — '틀림'이 아니라 '해당 없음'이다.
create or replace function qz_grade(it jsonb, val jsonb) returns boolean
language plpgsql immutable as $fn$
declare
  k text := it->>'kind';
  a jsonb := it->'answer';
begin
  if a is null or jsonb_typeof(a) = 'null' then return null; end if;

  if k in ('quiz','tf') then
    return (val #>> '{}') = (a #>> '{}');

  elsif k = 'multi' then
    return (select coalesce(array_agg(x order by x),'{}')
              from jsonb_array_elements_text(val) x)
         = (select coalesce(array_agg(y order by y),'{}')
              from jsonb_array_elements_text(a) y);

  elsif k = 'short' then
    -- 정답을 배열로 여러 개 적어 둘 수 있다.
    if jsonb_typeof(a) = 'array' then
      return exists (select 1 from jsonb_array_elements_text(a) y
                     where qz_norm(y) = qz_norm(val #>> '{}'));
    end if;
    return qz_norm(a #>> '{}') = qz_norm(val #>> '{}');

  elsif k = 'slider' then
    return abs((val #>> '{}')::numeric - (a->>'v')::numeric)
           <= coalesce((a->>'tol')::numeric, 0);
  end if;

  return null;   -- poll · scale · cloud · open
end $fn$;

-- 문항에서 **정답을 떼어 낸** 사본. 학생에게 나가는 것은 반드시 이걸 거친다.
create or replace function qz_strip(it jsonb) returns jsonb
language sql immutable as $fn$
  select (coalesce(it,'{}'::jsonb) - 'answer')
$fn$;

-- ============================================================
--  참여자용 (anon 에 열림) — 5개
-- ============================================================

-- 코드만 확인한다. 명렬 모드면 번호 고르개를 그려야 하므로 명단도 준다.
-- ⚠️ 코드를 아는 사람은 우리 반 이름을 본다. 코드는 수업 중에만 살아 있게 둘 것.
create or replace function qz_peek(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare s qz_sessions%rowtype; taken int[];
begin
  select * into s from qz_sessions
   where code = upper(btrim(p_code)) and ended_at is null limit 1;
  if not found then return jsonb_build_object('found', false); end if;

  select coalesce(array_agg(no),'{}') into taken
    from qz_players where session_id = s.id and no is not null;

  return jsonb_build_object(
    'found', true, 'mode', s.join_mode, 'title', s.title,
    'roster', case when s.join_mode = 'roster' then s.roster else '[]'::jsonb end,
    'taken', to_jsonb(taken));
end $fn$;

create or replace function qz_join(p_code text, p_guest text,
                                   p_nick text default null, p_no int default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare s qz_sessions%rowtype; nm text; owner_key text;
begin
  if coalesce(btrim(p_guest),'') = '' then raise exception '신원이 없어요.'; end if;

  select * into s from qz_sessions
   where code = upper(btrim(p_code)) and ended_at is null limit 1;
  if not found then raise exception '그런 코드의 퀴즈를 찾을 수 없어요.'; end if;

  if s.join_mode = 'roster' then
    if p_no is null then raise exception '번호를 골라 주세요.'; end if;
    select r->>'name' into nm from jsonb_array_elements(s.roster) r
     where (r->>'no')::int = p_no limit 1;
    if nm is null then raise exception '명단에 없는 번호예요.'; end if;

    -- 이미 그 번호로 들어와 있는 사람이 **나 자신인지** 본다. 새로고침을 막으면 안 된다.
    select guest_key into owner_key from qz_players
     where session_id = s.id and no = p_no limit 1;
    if owner_key is not null and owner_key <> p_guest then
      raise exception '%번은 이미 참여 중이에요.', p_no;
    end if;

    insert into qz_players(session_id, guest_key, no, name)
    values (s.id, p_guest, p_no, nm)
    on conflict (session_id, guest_key)
      do update set no = excluded.no, name = excluded.name;
  else
    if coalesce(btrim(p_nick),'') = '' then raise exception '별명을 적어 주세요.'; end if;
    insert into qz_players(session_id, guest_key, nick)
    values (s.id, p_guest, left(btrim(p_nick), 20))
    on conflict (session_id, guest_key) do update set nick = excluded.nick;
  end if;

  return jsonb_build_object('session', s.id, 'channel', s.channel,
                            'mode', s.join_mode, 'title', s.title);
end $fn$;

-- 화면의 유일한 진실 통로.
create or replace function qz_state(p_session uuid, p_guest text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  s qz_sessions%rowtype; it jsonb; me jsonb; dist jsonb;
  total int; left_ms int; secs int; answered int;
begin
  select * into s from qz_sessions where id = p_session and ended_at is null;
  if not found then return jsonb_build_object('found', false); end if;

  total := jsonb_array_length(s.items);
  if s.ord is not null and s.ord between 1 and total then
    it := s.items -> (s.ord - 1);
  end if;

  -- 남은 시간. 서버가 기준을 준다 — 학생 시계는 못 믿는다.
  if s.phase = 'question' and it is not null and s.q_opened_at is not null then
    secs := coalesce((it->>'seconds')::int, 20);
    left_ms := greatest(0, secs*1000
                 - (extract(epoch from (now() - s.q_opened_at)) * 1000)::int);
  end if;

  -- 몇 명이 냈는지는 문항 중에도 알려 준다(내용은 안 준다 — 그건 힌트가 된다).
  if s.ord is not null then
    select count(*) into answered from qz_answers
     where session_id = s.id and ord = s.ord;
  end if;

  -- 응답 분포와 정답은 공개 단계부터만.
  if s.phase in ('reveal','board','done') and s.ord is not null then
    select coalesce(jsonb_agg(jsonb_build_object('v', v, 'n', n) order by n desc), '[]'::jsonb)
      into dist
      from (select value as v, count(*) as n from qz_answers
             where session_id = s.id and ord = s.ord
             group by value order by count(*) desc limit 100) q;
  end if;

  if p_guest is not null then
    select jsonb_build_object(
             'nick', coalesce(p.nick, p.name), 'no', p.no, 'score', p.score,
             'answered', exists (select 1 from qz_answers a
                                  where a.session_id = s.id and a.ord = s.ord
                                    and a.guest_key = p_guest))
      into me from qz_players p where p.session_id = s.id and p.guest_key = p_guest;
  end if;

  return jsonb_build_object(
    'found', true, 'phase', s.phase, 'ord', s.ord, 'total', total,
    'title', s.title, 'channel', s.channel, 'left_ms', left_ms,
    'answered_n', coalesce(answered, 0),
    'players_n', (select count(*) from qz_players where session_id = s.id),
    'item', case when s.phase = 'question' then qz_strip(it) else it end,
    'dist', coalesce(dist, '[]'::jsonb),
    'me', me);
end $fn$;

create or replace function qz_answer(p_session uuid, p_ord int,
                                     p_value jsonb, p_guest text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  s qz_sessions%rowtype; it jsonb; ok boolean; secs int;
  el int; pts int; base int; ins int;
begin
  select * into s from qz_sessions where id = p_session and ended_at is null;
  if not found then raise exception '끝난 수업이에요.'; end if;
  if s.phase <> 'question' then raise exception '지금은 답을 받지 않아요.'; end if;
  if s.ord is distinct from p_ord then raise exception '이미 지난 문항이에요.'; end if;
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    raise exception '답이 비어 있어요.';
  end if;
  if not exists (select 1 from qz_players
                  where session_id = s.id and guest_key = p_guest) then
    raise exception '참여자가 아니에요. 다시 들어와 주세요.';
  end if;

  it   := s.items -> (s.ord - 1);
  secs := coalesce((it->>'seconds')::int, 20);
  el   := (extract(epoch from (now() - coalesce(s.q_opened_at, now()))) * 1000)::int;
  -- 1.5초는 봐준다. 네트워크가 느린 학생이 매번 손해 보면 안 된다.
  if el > secs*1000 + 1500 then raise exception '시간이 지났어요.'; end if;

  ok   := qz_grade(it, p_value);
  base := coalesce((it->>'points')::int, 100);
  pts  := 0;
  if ok then
    if s.speed then
      -- 절반은 맞힌 값, 절반은 속도. 늦어도 0점은 아니다.
      pts := round(base * (0.5 + 0.5 * greatest(0, 1 - el::numeric / (secs*1000))));
    else
      pts := base;
    end if;
  end if;

  -- 첫 응답만 남는다. 두 번째는 조용히 버린다(경쟁 조건에서 화면이 흔들리지 않게).
  insert into qz_answers(session_id, ord, guest_key, value, correct, ms, points)
  values (s.id, p_ord, p_guest, p_value, ok, el, pts)
  on conflict (session_id, ord, guest_key) do nothing;

  get diagnostics ins = row_count;
  if ins > 0 and pts > 0 then
    update qz_players set score = score + pts
     where session_id = s.id and guest_key = p_guest;
  end if;

  return jsonb_build_object('ok', true, 'counted', ins > 0);
end $fn$;

-- 문항이 열려 있는 동안에는 거절한다. 점수 변화로 정답이 샌다.
create or replace function qz_board(p_session uuid, p_guest text default null,
                                    p_top int default 10)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare s qz_sessions%rowtype; top jsonb; me jsonb;
begin
  select * into s from qz_sessions where id = p_session and ended_at is null;
  if not found then raise exception '끝난 수업이에요.'; end if;
  if s.phase = 'question' then raise exception '아직 볼 수 없어요.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'rk', rk, 'name', coalesce(nick, name), 'no', no, 'score', score)
         order by rk), '[]'::jsonb) into top
    from (select rank() over (order by score desc, joined_at) as rk,
                 nick, name, no, score
            from qz_players where session_id = s.id) q
   where rk <= greatest(1, least(coalesce(p_top,10), 50));

  if p_guest is not null then
    select jsonb_build_object('rk', rk, 'score', score) into me
      from (select rank() over (order by score desc, joined_at) as rk,
                   guest_key, score
              from qz_players where session_id = s.id) q
     where guest_key = p_guest;
  end if;

  return jsonb_build_object('top', top, 'me', me);
end $fn$;

-- ============================================================
--  진행자용 — 10개
--  로그인이 없다. 소유권은 브라우저가 만든 **긴 무작위 토큰**으로 증명한다.
--  ⚠️ 토큰은 비밀번호와 같다. 짧으면 추측당하므로 길이를 서버가 강제한다.
-- ============================================================

create or replace function qz_tok(t text) returns text
language plpgsql immutable as $fn$
begin
  if t is null or length(btrim(t)) < 32 then
    raise exception '진행 권한이 없어요.';
  end if;
  return btrim(t);
end $fn$;

create or replace function qz_save(p_token text, p_quiz uuid, p_title text,
                                   p_items jsonb, p_speed boolean default false,
                                   p_mode text default 'nick',
                                   p_roster jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); qid uuid;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception '문항이 배열이 아니에요.'; end if;
  if jsonb_array_length(p_items) > 60 then raise exception '문항은 60개까지예요.'; end if;
  if p_mode not in ('nick','roster') then raise exception '참여 방식이 이상해요.'; end if;

  if p_quiz is null then
    insert into qz_quizzes(owner_token, title, items, speed, join_mode, roster)
    values (tk, left(coalesce(btrim(p_title),'새 퀴즈'), 80), p_items,
            coalesce(p_speed,false), p_mode, coalesce(p_roster,'[]'::jsonb))
    returning id into qid;
  else
    update qz_quizzes
       set title = left(coalesce(btrim(p_title),'새 퀴즈'), 80),
           items = p_items, speed = coalesce(p_speed,false),
           join_mode = p_mode, roster = coalesce(p_roster,'[]'::jsonb),
           updated_at = now()
     where id = p_quiz and owner_token = tk
    returning id into qid;
    if qid is null then raise exception '내 퀴즈가 아니에요.'; end if;
  end if;

  return jsonb_build_object('quiz', qid);
end $fn$;

create or replace function qz_list(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'id', id, 'title', title, 'n', jsonb_array_length(items),
            'mode', join_mode, 'at', updated_at) order by updated_at desc), '[]'::jsonb)
          from qz_quizzes where owner_token = tk);
end $fn$;

create or replace function qz_get(p_quiz uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); r jsonb;
begin
  select jsonb_build_object('id', id, 'title', title, 'items', items,
                            'speed', speed, 'mode', join_mode, 'roster', roster)
    into r from qz_quizzes where id = p_quiz and owner_token = tk;
  if r is null then raise exception '내 퀴즈가 아니에요.'; end if;
  return r;
end $fn$;

create or replace function qz_del(p_quiz uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); n int;
begin
  delete from qz_quizzes where id = p_quiz and owner_token = tk;
  get diagnostics n = row_count;
  if n = 0 then raise exception '내 퀴즈가 아니에요.'; end if;
  return jsonb_build_object('ok', true);
end $fn$;

-- 진행 시작. 퀴즈 내용을 **세션으로 복사**한다 — 진행 중 편집이 수업을 흔들지 않게.
create or replace function qz_open(p_quiz uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); q qz_quizzes%rowtype; s qz_sessions%rowtype;
begin
  select * into q from qz_quizzes where id = p_quiz and owner_token = tk;
  if not found then raise exception '내 퀴즈가 아니에요.'; end if;
  if jsonb_array_length(q.items) = 0 then raise exception '문항이 없어요.'; end if;

  -- 이 브라우저가 열어 둔 옛 세션은 닫는다. 코드가 여럿 살아 있으면 학생이 헷갈린다.
  update qz_sessions set ended_at = now()
   where host_token = tk and ended_at is null;

  insert into qz_sessions(quiz_id, host_token, code, title, items, speed,
                          join_mode, roster)
  values (q.id, tk, qz_gen_code(), q.title, q.items, q.speed, q.join_mode, q.roster)
  returning * into s;

  return jsonb_build_object('session', s.id, 'code', s.code, 'channel', s.channel);
end $fn$;

create or replace function qz_phase(p_session uuid, p_token text,
                                    p_phase text, p_ord int default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); s qz_sessions%rowtype; total int;
begin
  select * into s from qz_sessions
   where id = p_session and host_token = tk and ended_at is null;
  if not found then raise exception '진행 권한이 없어요.'; end if;
  if p_phase not in ('lobby','question','reveal','board','done') then
    raise exception '알 수 없는 단계예요.';
  end if;

  total := jsonb_array_length(s.items);
  if p_phase = 'question' then
    if p_ord is null or p_ord < 1 or p_ord > total then
      raise exception '그런 문항이 없어요.';
    end if;
    -- 시계는 여기서 시작한다. 문항을 열 때만 갱신한다.
    update qz_sessions set phase = 'question', ord = p_ord, q_opened_at = now()
     where id = s.id;
  else
    update qz_sessions set phase = p_phase, q_opened_at = null where id = s.id;
  end if;

  return jsonb_build_object('ok', true);
end $fn$;

-- 교사 화면. 정답을 항상 준다(화면에 그릴지는 UI 가 정한다).
create or replace function qz_host_state(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  tk text := qz_tok(p_token); s qz_sessions%rowtype;
  it jsonb; dist jsonb; total int; left_ms int; secs int; answered int;
begin
  select * into s from qz_sessions
   where id = p_session and host_token = tk and ended_at is null;
  if not found then return jsonb_build_object('found', false); end if;

  total := jsonb_array_length(s.items);
  if s.ord is not null and s.ord between 1 and total then it := s.items -> (s.ord - 1); end if;

  if s.phase = 'question' and it is not null and s.q_opened_at is not null then
    secs := coalesce((it->>'seconds')::int, 20);
    left_ms := greatest(0, secs*1000
                 - (extract(epoch from (now() - s.q_opened_at)) * 1000)::int);
  end if;

  if s.ord is not null then
    select count(*) into answered from qz_answers where session_id = s.id and ord = s.ord;
    if s.phase in ('reveal','board','done') then
      select coalesce(jsonb_agg(jsonb_build_object('v', v, 'n', n) order by n desc), '[]'::jsonb)
        into dist
        from (select value as v, count(*) as n from qz_answers
               where session_id = s.id and ord = s.ord
               group by value order by count(*) desc limit 100) q;
    end if;
  end if;

  return jsonb_build_object(
    'found', true, 'phase', s.phase, 'ord', s.ord, 'total', total,
    'title', s.title, 'code', s.code, 'channel', s.channel, 'left_ms', left_ms,
    'answered_n', coalesce(answered,0),
    'players_n', (select count(*) from qz_players where session_id = s.id),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'name', coalesce(nick,name), 'no', no) order by joined_at), '[]'::jsonb)
                from qz_players where session_id = s.id),
    'item', it, 'dist', coalesce(dist,'[]'::jsonb));
end $fn$;

create or replace function qz_resume(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); s qz_sessions%rowtype;
begin
  select * into s from qz_sessions
   where host_token = tk and ended_at is null
   order by created_at desc limit 1;
  if not found then return jsonb_build_object('open', false); end if;
  return jsonb_build_object('open', true, 'session', s.id, 'code', s.code,
                            'channel', s.channel, 'title', s.title, 'phase', s.phase);
end $fn$;

-- 수업 뒤에 보는 결과. 형성평가 기록으로 쓸 수 있게 문항별·사람별 둘 다 준다.
create or replace function qz_report(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); s qz_sessions%rowtype;
begin
  select * into s from qz_sessions where id = p_session and host_token = tk;
  if not found then raise exception '진행 권한이 없어요.'; end if;

  return jsonb_build_object(
    'title', s.title, 'code', s.code,
    'at', s.created_at,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'ord', i, 'prompt', (s.items->(i-1))->>'prompt',
                'kind', (s.items->(i-1))->>'kind',
                'n',  (select count(*) from qz_answers a
                        where a.session_id = s.id and a.ord = i),
                'ok', (select count(*) from qz_answers a
                        where a.session_id = s.id and a.ord = i and a.correct)
              ) order by i), '[]'::jsonb)
              from generate_series(1, jsonb_array_length(s.items)) i),
    'players', (select coalesce(jsonb_agg(jsonb_build_object(
                  'no', p.no, 'name', coalesce(p.nick, p.name), 'score', p.score,
                  'ok', (select count(*) from qz_answers a
                          where a.session_id = s.id and a.guest_key = p.guest_key
                            and a.correct)
                ) order by p.score desc), '[]'::jsonb)
                from qz_players p where p.session_id = s.id));
end $fn$;

create or replace function qz_end(p_session uuid, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare tk text := qz_tok(p_token); n int;
begin
  update qz_sessions set ended_at = now(), phase = 'done'
   where id = p_session and host_token = tk and ended_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception '진행 권한이 없어요.'; end if;
  return jsonb_build_object('ok', true);
end $fn$;

-- 열쇠를 바꿀 때 내 퀴즈를 함께 옮긴다.
-- 옛 열쇠를 아는 사람은 이미 그 퀴즈의 주인이므로 새로 열리는 권한은 없다.
create or replace function qz_reown(p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare o text := qz_tok(p_old); n text := qz_tok(p_new); c int;
begin
  if o = n then return jsonb_build_object('moved', 0); end if;
  update qz_quizzes set owner_token = n where owner_token = o;
  get diagnostics c = row_count;
  update qz_sessions set host_token = n where host_token = o and ended_at is null;
  return jsonb_build_object('moved', c);
end $fn$;

-- ============================================================
--  권한 — 여기 없는 것은 브라우저가 못 부른다
-- ============================================================

revoke all on function qz_gen_code() from public, anon, authenticated;

grant execute on function
  qz_peek(text),
  qz_join(text, text, text, int),
  qz_state(uuid, text),
  qz_answer(uuid, int, jsonb, text),
  qz_board(uuid, text, int),
  qz_save(text, uuid, text, jsonb, boolean, text, jsonb),
  qz_list(text),
  qz_get(uuid, text),
  qz_del(uuid, text),
  qz_open(uuid, text),
  qz_phase(uuid, text, text, int),
  qz_host_state(uuid, text),
  qz_resume(text),
  qz_report(uuid, text),
  qz_end(uuid, text),
  qz_reown(text, text)
to anon;

-- 끝. Supabase > Database > Realtime 에서 Broadcast 는 기본 켜져 있다.
-- 이 설계는 DB 에서 broadcast 를 보내지 않는다 — 교사 브라우저가 직접 쏜다.
