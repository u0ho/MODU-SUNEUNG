-- Supabase SQL Editor에서 실행 (여러 번 실행해도 안전 / 기존 테이블 자동 마이그레이션)
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  content    text not null,
  created_at timestamptz not null default now()
);

alter table public.messages
  add column if not exists password_hash   text,                          -- bcrypt 해시 (클라이언트에 노출 안 됨)
  add column if not exists reactions       jsonb not null default '{}'::jsonb,
  add column if not exists failed_attempts int   not null default 0,
  add column if not exists locked_until    timestamptz,
  add column if not exists color           text  not null default 'white';

alter table public.messages drop constraint if exists messages_color_check;
alter table public.messages
  add constraint messages_color_check check (color in (
    'white', 'rose', 'peach', 'butter', 'lime', 'mint',
    'aqua', 'sky', 'periwinkle', 'lavender', 'sand'));

alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages
  add constraint messages_content_check check (
    char_length(content) between 1 and 500
    and char_length(btrim(content)) >= 1
  );

create index if not exists messages_created_at_idx
  on public.messages (created_at desc);

-- ── 접근 권한: 공개 컬럼 읽기만 허용, 쓰기는 아래 함수로만 ──
alter table public.messages enable row level security;
drop policy if exists "anon read"   on public.messages;
drop policy if exists "anon insert" on public.messages;
create policy "anon read" on public.messages for select to anon, authenticated using (true);

revoke all on public.messages from anon, authenticated;
grant select (id, content, created_at, reactions, color) on public.messages to anon, authenticated;

-- ── 메시지 등록 (암호는 서버에서 해시) ──
drop function if exists public.post_message(uuid, text, text); -- 이전 버전(컬러 없음) 제거
create or replace function public.post_message(p_id uuid, p_content text, p_password text, p_color text default 'white')
returns table (id uuid, content text, created_at timestamptz, reactions jsonb, color text)
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare v_content text := btrim(coalesce(p_content, ''));
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22023';
  end if;
  if char_length(v_content) not between 1 and 500 then
    raise exception 'content must be 1-500 non-whitespace characters' using errcode = '22023';
  end if;
  if char_length(coalesce(p_password, '')) not between 4 and 72 then
    raise exception 'password must be 4-72 characters' using errcode = '22023';
  end if;
  return query
    insert into public.messages as m (id, content, password_hash, color)
    values (p_id, v_content, crypt(p_password, gen_salt('bf', 8)), coalesce(nullif(p_color, ''), 'white'))
    returning m.id, m.content, m.created_at, m.reactions, m.color;
end $$;

-- ── 메시지 삭제: 'deleted' | 'wrong_password' | 'locked' | 'not_found' ──
-- 암호 5회 오류부터 지수적 잠금(10분 * 2^n)을 적용해 무차별 대입 방지
create or replace function public.delete_message(p_id uuid, p_password text)
returns text
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare r record;
declare next_attempts int;
begin
  if p_id is null then return 'not_found'; end if;
  select m.password_hash, m.failed_attempts, m.locked_until
    into r from public.messages m where m.id = p_id for update;
  if not found then return 'not_found'; end if;
  if r.locked_until is not null and r.locked_until > now() then return 'locked'; end if;

  if r.password_hash is null
     or r.password_hash <> crypt(coalesce(p_password, ''), r.password_hash) then
    next_attempts := r.failed_attempts + 1;
    update public.messages m
       set failed_attempts = next_attempts,
           locked_until    = case
             when next_attempts >= 5
             then now() + (interval '10 minutes' * power(2, least(next_attempts - 5, 6)))
             else m.locked_until
           end
     where m.id = p_id;
    return 'wrong_password';
  end if;

  delete from public.messages m where m.id = p_id;
  return 'deleted';
end $$;

-- ── 감정표현: 원자적 증감 후 최신 카운트 반환 ──
create or replace function public.react_message(p_id uuid, p_key text, p_delta int)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  if p_id is null then
    raise exception 'id is required' using errcode = '22023';
  end if;
  if p_key not in ('like', 'love', 'cheer', 'fire', 'tear') or p_delta not in (1, -1) then
    raise exception 'invalid reaction' using errcode = '22023';
  end if;
  update public.messages m
     set reactions = jsonb_set(m.reactions, array[p_key],
           to_jsonb(least(999999999, greatest(0, coalesce((m.reactions ->> p_key)::bigint, 0) + p_delta))))
   where m.id = p_id
   returning m.reactions into v;
  if not found then raise exception 'message not found' using errcode = 'P0002'; end if;
  return v;
end $$;

revoke all on function public.post_message(uuid, text, text, text) from public;
revoke all on function public.delete_message(uuid, text)       from public;
revoke all on function public.react_message(uuid, text, int)   from public;
grant execute on function public.post_message(uuid, text, text, text) to anon, authenticated;
grant execute on function public.delete_message(uuid, text)     to anon, authenticated;
grant execute on function public.react_message(uuid, text, int) to anon, authenticated;
