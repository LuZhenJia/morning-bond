-- =====================================================================
--  晨光羈絆 Morning-Bond — Supabase 資料庫結構（schema.sql）
--  執行方式：Supabase Dashboard → SQL Editor → 貼上本檔全部內容 → Run
--  執行順序：先 schema.sql，再 policies.sql
--  本檔可重複執行（create if not exists / create or replace / drop trigger if exists）。
--
--  設計重點
--  1. game_saves.state 以 JSONB 完整保存遊戲的 S 物件（不拆欄位，避免遺漏）。
--  2. revision 由伺服器遞增，用來做「比對後寫入」（compare-and-set），防止多裝置互相覆蓋。
--  3. 每次重要變更前，自動把舊版存檔備份到 save_snapshots（保留最近 40 份）。
--  4. memories 由觸發器從存檔萃取「劇情、徽章、收藏、家人訊息、修行日誌、結局」，只增不改。
--  5. 一位玩家（players）可以連結多個匿名身分（player_members），用復原代碼加入。
--  6. 復原代碼只存 HMAC 雜湊，驗證只能透過 Edge Function（service role）進行。
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. 資料表
-- ---------------------------------------------------------------------

-- 玩家（遊戲中的「一個人」；可對應多個匿名身分＝多台裝置）
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  -- 寫入速率限制（每 10 分鐘最多 300 次存檔寫入）
  write_window_start timestamptz not null default now(),
  write_count integer not null default 0 check (write_count >= 0)
);

-- 匿名身分 ↔ 玩家（一個匿名身分只屬於一位玩家）
create table if not exists public.player_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  joined_via text not null default 'anonymous' check (joined_via in ('anonymous', 'recovery')),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  device_label text check (device_label is null or char_length(device_label) <= 80)
);
create index if not exists player_members_player_idx on public.player_members (player_id);

-- 遊戲存檔（完整 S 物件）
create table if not exists public.game_saves (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  slot text not null default 'main' check (slot ~ '^[A-Za-z0-9_-]{1,32}$'),
  state jsonb not null,
  state_version integer not null default 1,
  revision bigint not null default 1 check (revision >= 1),
  checksum text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null default 0,
  started boolean not null default false,
  settled_through text,
  player_level integer,
  last_client_id text check (last_client_id is null or char_length(last_client_id) <= 64),
  last_reason text check (last_reason is null or char_length(last_reason) <= 40),
  last_op_id uuid,
  last_snapshot_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_saves_player_slot_key unique (player_id, slot)
);

-- 存檔備份（每次重要變更前的舊版本）
create table if not exists public.save_snapshots (
  id uuid primary key default gen_random_uuid(),
  save_id uuid not null references public.game_saves (id) on delete cascade,
  player_id uuid not null references public.players (id) on delete cascade,
  revision bigint not null,
  state jsonb not null,
  state_version integer not null,
  checksum text,
  reason text not null check (char_length(reason) <= 40),
  size_bytes integer not null default 0,
  settled_through text,
  player_level integer,
  created_at timestamptz not null default now()
);
create index if not exists save_snapshots_save_idx on public.save_snapshots (save_id, created_at desc);
create index if not exists save_snapshots_player_idx on public.save_snapshots (player_id);

-- 對話與回憶紀錄（由存檔萃取；只增不改）
--   story       解鎖的劇情（對話場景），key = 劇情 id
--   achievement 徽章，key = 徽章 id
--   collection  收藏，key = 收藏 id
--   share       家人（妹妹）傳來的訊息，key = md5(日期|內容)
--   log         修行日誌，key = md5(日期|內容)
--   ending      學期結局，key = 日期|結局類型
create table if not exists public.memories (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players (id) on delete cascade,
  save_id uuid not null references public.game_saves (id) on delete cascade,
  kind text not null check (kind in ('story', 'achievement', 'collection', 'share', 'log', 'ending')),
  memory_key text not null check (char_length(memory_key) between 1 and 200),
  occurred_on text check (occurred_on is null or occurred_on ~ '^\d{4}-\d{2}-\d{2}$'),
  content jsonb not null default '{}'::jsonb check (octet_length(content::text) <= 4000),
  created_at timestamptz not null default now(),
  constraint memories_save_kind_key unique (save_id, kind, memory_key)
);
create index if not exists memories_player_idx on public.memories (player_id, kind, occurred_on desc);

-- 復原代碼（只存 HMAC-SHA256 雜湊；明碼只在產生當下回傳一次）
create table if not exists public.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz
);
create index if not exists recovery_codes_active_idx on public.recovery_codes (player_id) where used_at is null and revoked_at is null;

-- 復原嘗試紀錄（速率限制用；IP 只存雜湊）
create table if not exists public.recovery_attempts (
  id bigint generated always as identity primary key,
  user_id uuid,
  ip_hash text,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists recovery_attempts_user_idx on public.recovery_attempts (user_id, created_at desc);
create index if not exists recovery_attempts_ip_idx on public.recovery_attempts (ip_hash, created_at desc);

-- 身分連結異動紀錄（管理者救援用：誰從哪個玩家改連到哪個玩家）
create table if not exists public.membership_changes (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  from_player_id uuid,
  to_player_id uuid not null,
  reason text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
--  2. 共用函式
-- ---------------------------------------------------------------------

-- 目前登入身分所屬的玩家 id（RLS 與 RPC 共用；security definer 避免遞迴的 RLS 檢查）
create or replace function public.mb_current_player_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.player_id from public.player_members m where m.user_id = (select auth.uid())
$$;

-- 存檔結構驗證：只接受「看得出是晨光羈絆存檔」的物件
create or replace function public.mb_validate_state(p_state jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'invalid_state: not an object' using errcode = '22023';
  end if;
  if jsonb_typeof(p_state -> 'version') is distinct from 'number' then
    raise exception 'invalid_state: version' using errcode = '22023';
  end if;
  if (p_state ->> 'version')::numeric < 1 or (p_state ->> 'version')::numeric > 1000 then
    raise exception 'invalid_state: version range' using errcode = '22023';
  end if;
  foreach k in array array['profile', 'settings', 'player', 'bonds', 'items', 'days'] loop
    if jsonb_typeof(p_state -> k) is distinct from 'object' then
      raise exception 'invalid_state: % must be an object', k using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(p_state -> 'schedule') is distinct from 'array' then
    raise exception 'invalid_state: schedule must be an array' using errcode = '22023';
  end if;
  if p_state ? 'started' and jsonb_typeof(p_state -> 'started') <> 'boolean' then
    raise exception 'invalid_state: started must be boolean' using errcode = '22023';
  end if;
  if octet_length(p_state::text) > 3000000 then
    raise exception 'state_too_large' using errcode = '54000';
  end if;
end;
$$;

-- 寫入前：驗證、衍生欄位、版本遞增、防空白覆蓋、自動備份、速率限制
create or replace function public.mb_game_saves_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_snap boolean := false;
  v_reason text;
begin
  perform public.mb_validate_state(new.state);
  new.state_version := floor((new.state ->> 'version')::numeric)::integer;
  new.size_bytes := octet_length(new.state::text);
  new.started := case when jsonb_typeof(new.state -> 'started') = 'boolean' then (new.state ->> 'started')::boolean else false end;
  new.settled_through := case when jsonb_typeof(new.state -> 'settledThrough') = 'string' then left(new.state ->> 'settledThrough', 10) else null end;
  new.player_level := case when jsonb_typeof(new.state -> 'player' -> 'level') = 'number'
                           then floor((new.state -> 'player' ->> 'level')::numeric)::integer else null end;

  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := now();
    new.updated_at := now();
    new.last_snapshot_at := null;
    select count(*) into v_count from public.game_saves g where g.player_id = new.player_id;
    if v_count >= 5 then
      raise exception 'too_many_saves' using errcode = 'P0001';
    end if;
  else
    if new.id <> old.id or new.player_id <> old.player_id or new.slot <> old.slot then
      raise exception 'immutable_columns' using errcode = 'P0001';
    end if;
    v_reason := coalesce(new.last_reason, '');
    -- 已開始的存檔，不允許被「尚未開始」的空白存檔覆蓋（明確的重新開始 reset 除外）
    if old.started and not new.started and v_reason <> 'reset' then
      raise exception 'refuse_blank_overwrite' using errcode = 'P0001';
    end if;
    -- 不允許用舊版本的資料格式覆蓋新版本（還原、匯入、重新開始除外）
    if new.state_version < old.state_version and v_reason not in ('restore', 'import', 'reset') then
      raise exception 'version_downgrade' using errcode = 'P0001';
    end if;
    -- 沒有帶新的操作編號（不是透過 update_game_save／restore_game_save 的寫入，例如直接改資料表）：
    -- 不可沿用上一筆的操作編號與裝置資訊，否則用戶端會把這次修改誤認成自己先前送出的寫入
    if new.last_op_id is not distinct from old.last_op_id then
      new.last_op_id := null;
      if new.last_client_id is not distinct from old.last_client_id then
        new.last_client_id := null;
      end if;
    end if;
    new.revision := old.revision + 1;
    new.created_at := old.created_at;
    new.updated_at := now();
    if old.state is distinct from new.state then
      v_snap := v_reason in ('import', 'restore', 'reset', 'conflict-keep-local', 'conflict-keep-cloud', 'migration', 'recovery', 'newsem')
             or old.settled_through is distinct from new.settled_through
             or old.last_snapshot_at is null
             or old.last_snapshot_at < now() - interval '6 hours';
    end if;
    if v_snap then
      insert into public.save_snapshots (save_id, player_id, revision, state, state_version, checksum, reason, size_bytes, settled_through, player_level)
      values (old.id, old.player_id, old.revision, old.state, old.state_version, old.checksum,
              coalesce(nullif(v_reason, ''), 'autosave'), old.size_bytes, old.settled_through, old.player_level);
      new.last_snapshot_at := now();
      delete from public.save_snapshots s
       where s.save_id = old.id
         and s.id in (select s2.id from public.save_snapshots s2 where s2.save_id = old.id
                      order by s2.created_at desc, s2.revision desc offset 40);
    else
      new.last_snapshot_at := old.last_snapshot_at;
    end if;
  end if;

  update public.players p
     set write_count = case when p.write_window_start < now() - interval '10 minutes' then 1 else p.write_count + 1 end,
         write_window_start = case when p.write_window_start < now() - interval '10 minutes' then now() else p.write_window_start end,
         updated_at = now()
   where p.id = new.player_id
  returning p.write_count into v_count;
  if v_count > 300 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- 寫入後：萃取對話與回憶（只增不改；每份存檔最多 20000 筆）
create or replace function public.mb_extract_memories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  s jsonb := new.state;
  o jsonb := case when tg_op = 'UPDATE' then old.state else '{}'::jsonb end;
  date_re constant text := '^\d{4}-\d{2}-\d{2}$';
begin
  if tg_op = 'UPDATE' and old.state is not distinct from new.state then
    return null;
  end if;
  select count(*) into v_count from public.memories m where m.save_id = new.id;
  if v_count >= 20000 then
    return null;
  end if;

  if (s -> 'album') is distinct from (o -> 'album') and jsonb_typeof(s -> 'album') = 'object' then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'story', left(e.key, 200),
           case when jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ date_re then e.value #>> '{}' end,
           jsonb_build_object('date', e.value)
      from jsonb_each(s -> 'album') e
     where char_length(e.key) >= 1
    on conflict (save_id, kind, memory_key) do nothing;
  end if;

  if (s -> 'achievements') is distinct from (o -> 'achievements') and jsonb_typeof(s -> 'achievements') = 'object' then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'achievement', left(e.key, 200),
           case when jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ date_re then e.value #>> '{}' end,
           jsonb_build_object('date', e.value)
      from jsonb_each(s -> 'achievements') e
     where char_length(e.key) >= 1
    on conflict (save_id, kind, memory_key) do nothing;
  end if;

  if (s -> 'collection') is distinct from (o -> 'collection') and jsonb_typeof(s -> 'collection') = 'object' then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'collection', left(e.key, 200),
           case when jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') ~ date_re then e.value #>> '{}' end,
           jsonb_build_object('date', e.value)
      from jsonb_each(s -> 'collection') e
     where char_length(e.key) >= 1
    on conflict (save_id, kind, memory_key) do nothing;
  end if;

  if (s -> 'shares') is distinct from (o -> 'shares') and jsonb_typeof(s -> 'shares') = 'array' then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'share', md5(coalesce(x ->> 'd', '') || '|' || coalesce(x ->> 't', '')),
           case when (x ->> 'd') ~ date_re then x ->> 'd' end,
           jsonb_build_object('d', x -> 'd', 't', left(coalesce(x ->> 't', ''), 1000))
      from jsonb_array_elements(s -> 'shares') x
     where jsonb_typeof(x) = 'object'
    on conflict (save_id, kind, memory_key) do nothing;
  end if;

  if (s -> 'log') is distinct from (o -> 'log') and jsonb_typeof(s -> 'log') = 'array' then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'log', md5(coalesce(x ->> 'd', '') || '|' || coalesce(x ->> 't', '')),
           case when (x ->> 'd') ~ date_re then x ->> 'd' end,
           jsonb_build_object('d', x -> 'd', 't', left(coalesce(x ->> 't', ''), 1000))
      from jsonb_array_elements(s -> 'log') x
     where jsonb_typeof(x) = 'object'
    on conflict (save_id, kind, memory_key) do nothing;
  end if;

  if ((s -> 'ending') is distinct from (o -> 'ending') or (s -> 'history') is distinct from (o -> 'history')) then
    insert into public.memories (player_id, save_id, kind, memory_key, occurred_on, content)
    select new.player_id, new.id, 'ending', left(coalesce(x ->> 'date', '') || '|' || coalesce(x ->> 'type', ''), 200),
           case when (x ->> 'date') ~ date_re then x ->> 'date' end,
           x
      from (
        select s -> 'ending' as x where jsonb_typeof(s -> 'ending') = 'object'
        union all
        select h from jsonb_array_elements(case when jsonb_typeof(s -> 'history') = 'array' then s -> 'history' else '[]'::jsonb end) h
         where jsonb_typeof(h) = 'object'
      ) e
     where octet_length(x::text) <= 4000
    on conflict (save_id, kind, memory_key) do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists game_saves_before_write on public.game_saves;
create trigger game_saves_before_write
  before insert or update on public.game_saves
  for each row execute function public.mb_game_saves_before_write();

drop trigger if exists game_saves_after_write on public.game_saves;
create trigger game_saves_after_write
  after insert or update on public.game_saves
  for each row execute function public.mb_extract_memories();

-- 照片數量（Storage 政策用）
create or replace function public.mb_photo_count(p_player uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from storage.objects o
   where o.bucket_id = 'player-photos' and o.name like p_player::text || '/%'
$$;

-- ---------------------------------------------------------------------
--  3. 前端可呼叫的 RPC（authenticated；除 ensure_player 外都以呼叫者身分執行，受 RLS 限制）
--     全部回傳 jsonb，方便 PostgREST 與前端一致處理。
-- ---------------------------------------------------------------------

-- 確保目前的匿名身分有對應的玩家（第一次進入時建立）
create or replace function public.ensure_player(p_device_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_pid uuid;
  v_new uuid;
  v_created boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select m.player_id into v_pid from public.player_members m where m.user_id = v_uid;
  if v_pid is null then
    insert into public.players (created_by) values (v_uid) returning id into v_new;
    insert into public.player_members (user_id, player_id, joined_via, device_label)
    values (v_uid, v_new, 'anonymous', left(p_device_label, 80))
    on conflict (user_id) do nothing;
    select m.player_id into v_pid from public.player_members m where m.user_id = v_uid;
    if v_pid = v_new then
      v_created := true;
    else
      delete from public.players p where p.id = v_new;   -- 同時呼叫時，刪掉多建立的那一筆
    end if;
  else
    update public.player_members
       set last_seen_at = now(), device_label = coalesce(left(p_device_label, 80), device_label)
     where user_id = v_uid;
  end if;
  return jsonb_build_object(
    'player_id', v_pid,
    'user_id', v_uid,
    'created', v_created,
    'is_anonymous', coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  );
end;
$$;

-- 雲端存檔摘要（不含完整 state，用來快速比對版本）
create or replace function public.get_save_head(p_slot text default 'main')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', g.id, 'slot', g.slot, 'revision', g.revision, 'checksum', g.checksum,
    'state_version', g.state_version, 'started', g.started, 'settled_through', g.settled_through,
    'player_level', g.player_level, 'size_bytes', g.size_bytes, 'last_client_id', g.last_client_id,
    'last_op_id', g.last_op_id, 'last_reason', g.last_reason, 'created_at', g.created_at, 'updated_at', g.updated_at)
    from public.game_saves g
   where g.slot = coalesce(p_slot, 'main')
     and g.player_id = (select public.mb_current_player_id())
$$;

-- 讀取完整雲端存檔
create or replace function public.load_game_save(p_slot text default 'main')
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', g.id, 'slot', g.slot, 'revision', g.revision, 'checksum', g.checksum,
    'state_version', g.state_version, 'started', g.started, 'settled_through', g.settled_through,
    'player_level', g.player_level, 'size_bytes', g.size_bytes, 'last_client_id', g.last_client_id,
    'last_op_id', g.last_op_id, 'last_reason', g.last_reason, 'created_at', g.created_at, 'updated_at', g.updated_at,
    'state', g.state)
    from public.game_saves g
   where g.slot = coalesce(p_slot, 'main')
     and g.player_id = (select public.mb_current_player_id())
$$;

-- 建立雲端存檔（同一位玩家同一個 slot 只能有一份；已存在時回傳 save_exists，不覆蓋）
create or replace function public.create_game_save(
  p_slot text,
  p_state jsonb,
  p_checksum text default null,
  p_client_id text default null,
  p_reason text default 'create',
  p_op_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pid uuid := public.mb_current_player_id();
  v_row public.game_saves;
begin
  if v_pid is null then
    raise exception 'no_player' using errcode = '42501';
  end if;
  begin
    insert into public.game_saves (player_id, slot, state, checksum, last_client_id, last_reason, last_op_id)
    values (v_pid, coalesce(p_slot, 'main'), p_state, p_checksum, left(p_client_id, 64), left(coalesce(p_reason, 'create'), 40), p_op_id)
    returning * into v_row;
  exception when unique_violation then
    select * into v_row from public.game_saves g where g.player_id = v_pid and g.slot = coalesce(p_slot, 'main');
    if p_op_id is not null and v_row.last_op_id = p_op_id then
      -- 同一個操作重送（上一次其實成功了，只是回應遺失）
      return jsonb_build_object('ok', true, 'duplicate', true, 'id', v_row.id, 'revision', v_row.revision,
                                'checksum', v_row.checksum, 'updated_at', v_row.updated_at, 'player_id', v_pid);
    end if;
    return jsonb_build_object('ok', false, 'error', 'save_exists', 'id', v_row.id, 'revision', v_row.revision,
                              'checksum', v_row.checksum, 'updated_at', v_row.updated_at, 'started', v_row.started);
  end;
  return jsonb_build_object('ok', true, 'id', v_row.id, 'revision', v_row.revision, 'checksum', v_row.checksum,
                            'updated_at', v_row.updated_at, 'player_id', v_pid);
end;
$$;

-- 更新雲端存檔：只有在雲端 revision 等於 p_base_revision 時才寫入（比對後寫入）
create or replace function public.update_game_save(
  p_save_id uuid,
  p_state jsonb,
  p_base_revision bigint,
  p_checksum text default null,
  p_client_id text default null,
  p_reason text default 'autosave',
  p_op_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.game_saves;
  v_cur record;
begin
  update public.game_saves g
     set state = p_state, checksum = p_checksum, last_client_id = left(p_client_id, 64),
         last_reason = left(coalesce(p_reason, 'autosave'), 40), last_op_id = p_op_id
   where g.id = p_save_id and g.revision = p_base_revision
  returning * into v_row;
  if found then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'revision', v_row.revision, 'checksum', v_row.checksum, 'updated_at', v_row.updated_at);
  end if;
  select g.id, g.revision, g.checksum, g.last_op_id, g.updated_at, g.last_client_id into v_cur
    from public.game_saves g where g.id = p_save_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_op_id is not null and v_cur.last_op_id = p_op_id then
    return jsonb_build_object('ok', true, 'duplicate', true, 'id', v_cur.id, 'revision', v_cur.revision,
                              'checksum', v_cur.checksum, 'updated_at', v_cur.updated_at);
  end if;
  return jsonb_build_object('ok', false, 'error', 'revision_conflict', 'revision', v_cur.revision,
                            'checksum', v_cur.checksum, 'updated_at', v_cur.updated_at, 'last_client_id', v_cur.last_client_id);
end;
$$;

-- 刪除雲端存檔（連同備份與回憶紀錄；本機存檔不受影響）
create or replace function public.delete_game_save(p_save_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.game_saves g where g.id = p_save_id;
  return jsonb_build_object('ok', found);
end;
$$;

-- 列出雲端備份
create or replace function public.list_save_snapshots(p_save_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'revision', s.revision, 'reason', s.reason, 'created_at', s.created_at,
           'settled_through', s.settled_through, 'player_level', s.player_level, 'size_bytes', s.size_bytes)
           order by s.created_at desc, s.revision desc), '[]'::jsonb)
    from public.save_snapshots s
   where s.save_id = p_save_id
$$;

-- 從備份還原（還原前的版本也會自動備份）
create or replace function public.restore_game_save(
  p_save_id uuid,
  p_snapshot_id uuid,
  p_base_revision bigint,
  p_client_id text default null,
  p_op_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_snap record;
  v_res jsonb;
begin
  select s.state, s.checksum into v_snap from public.save_snapshots s where s.id = p_snapshot_id and s.save_id = p_save_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'snapshot_not_found');
  end if;
  v_res := public.update_game_save(p_save_id, v_snap.state, p_base_revision, v_snap.checksum, p_client_id, 'restore', p_op_id);
  if (v_res ->> 'ok')::boolean then
    v_res := v_res || jsonb_build_object('state', v_snap.state);
  end if;
  return v_res;
end;
$$;

-- 對話與回憶：各類數量與最近的紀錄
create or replace function public.list_memories(p_slot text default 'main', p_kind text default null, p_limit integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select m.* from public.memories m
      join public.game_saves g on g.id = m.save_id
     where g.slot = coalesce(p_slot, 'main') and g.player_id = (select public.mb_current_player_id())
  )
  select jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) as n from mine group by kind) c), '{}'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'key', x.memory_key, 'occurred_on', x.occurred_on,
                                                          'content', x.content, 'created_at', x.created_at)
                                        order by x.occurred_on desc nulls last, x.id desc)
                         from (select * from mine where p_kind is null or kind = p_kind
                               order by occurred_on desc nulls last, id desc
                               limit least(greatest(coalesce(p_limit, 50), 1), 500)) x), '[]'::jsonb)
  )
$$;

-- 已連結的裝置（同一位玩家的匿名身分）
create or replace function public.list_player_devices()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id_short', left(m.user_id::text, 8), 'joined_via', m.joined_via, 'joined_at', m.joined_at,
           'last_seen_at', m.last_seen_at, 'device_label', m.device_label, 'is_current', m.user_id = (select auth.uid()))
           order by m.joined_at), '[]'::jsonb)
    from public.player_members m
   where m.player_id = (select public.mb_current_player_id())
$$;

-- 仍被「目前存檔或任何雲端備份」引用的照片路徑。
-- 前端刪除舊照片前會先查這裡：只要還有備份用到，就不刪（之後從備份還原時照片才不會不見）。
create or replace function public.list_photo_paths_in_use()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with me as (select public.mb_current_player_id() as pid),
  states as (
    select g.state from public.game_saves g, me where g.player_id = me.pid
    union all
    select s.state from public.save_snapshots s join public.game_saves g on g.id = s.save_id, me where g.player_id = me.pid
  )
  select coalesce(jsonb_agg(distinct r.value->>'path') filter (where r.value->>'path' is not null), '[]'::jsonb)
    from states st
    cross join lateral jsonb_each(
      case when jsonb_typeof(st.state->'profile'->'photoRefs') = 'object' then st.state->'profile'->'photoRefs' else '{}'::jsonb end) r
   where jsonb_typeof(r.value) = 'object'
$$;

-- ---------------------------------------------------------------------
--  4. 復原代碼（只給 Edge Function 以 service role 呼叫）
-- ---------------------------------------------------------------------

create or replace function public.recovery_issue(p_user_id uuid, p_code_hash text, p_ttl_hours integer default 168)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pid uuid;
  v_exp timestamptz;
  v_recent integer;
begin
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = '22023';
  end if;
  select m.player_id into v_pid from public.player_members m where m.user_id = p_user_id;
  if v_pid is null then
    return jsonb_build_object('ok', false, 'error', 'no_player');
  end if;
  select count(*) into v_recent from public.recovery_codes c where c.player_id = v_pid and c.created_at > now() - interval '1 day';
  if v_recent >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  update public.recovery_codes c set revoked_at = now()
   where c.player_id = v_pid and c.used_at is null and c.revoked_at is null;
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_ttl_hours, 168), 720)));
  insert into public.recovery_codes (player_id, created_by, code_hash, expires_at) values (v_pid, p_user_id, p_code_hash, v_exp);
  return jsonb_build_object('ok', true, 'player_id', v_pid, 'expires_at', v_exp);
end;
$$;

create or replace function public.recovery_redeem(p_user_id uuid, p_code_hash text, p_ip_hash text default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.recovery_codes;
  v_fail_user integer;
  v_fail_ip integer := 0;
  v_old_pid uuid;
  v_has_progress boolean;
  v_others integer;
begin
  if p_user_id is null then
    raise exception 'missing_user' using errcode = '22023';
  end if;
  delete from public.recovery_attempts a where a.created_at < now() - interval '7 days';
  select count(*) into v_fail_user from public.recovery_attempts a
   where a.user_id = p_user_id and not a.success and a.created_at > now() - interval '1 hour';
  if p_ip_hash is not null then
    select count(*) into v_fail_ip from public.recovery_attempts a
     where a.ip_hash = p_ip_hash and not a.success and a.created_at > now() - interval '1 hour';
  end if;
  if v_fail_user >= 5 or v_fail_ip >= 20 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into v_code from public.recovery_codes c where c.code_hash = p_code_hash for update;
  if not found or v_code.revoked_at is not null or v_code.used_at is not null or v_code.expires_at <= now() then
    insert into public.recovery_attempts (user_id, ip_hash, success) values (p_user_id, p_ip_hash, false);
    return jsonb_build_object('ok', false, 'error',
      case when v_code.id is null then 'invalid_code'
           when v_code.used_at is not null then 'code_used'
           when v_code.revoked_at is not null then 'code_revoked'
           else 'code_expired' end);
  end if;

  select m.player_id into v_old_pid from public.player_members m where m.user_id = p_user_id;
  if v_old_pid = v_code.player_id then
    update public.recovery_codes c set used_at = now(), used_by = p_user_id where c.id = v_code.id;
    insert into public.recovery_attempts (user_id, ip_hash, success) values (p_user_id, p_ip_hash, true);
    return jsonb_build_object('ok', true, 'player_id', v_code.player_id, 'already_member', true);
  end if;

  if v_old_pid is not null and not coalesce(p_force, false) then
    select exists (select 1 from public.game_saves g where g.player_id = v_old_pid and g.started) into v_has_progress;
    select count(*) into v_others from public.player_members m where m.player_id = v_old_pid and m.user_id <> p_user_id;
    if v_has_progress and v_others = 0 then
      -- 這個身分自己也有雲端進度，改連結後會無法再從這台裝置讀到 → 需要使用者確認（不消耗代碼）
      return jsonb_build_object('ok', false, 'error', 'has_own_progress');
    end if;
  end if;

  insert into public.player_members (user_id, player_id, joined_via)
  values (p_user_id, v_code.player_id, 'recovery')
  on conflict (user_id) do update
    set player_id = excluded.player_id, joined_via = 'recovery', joined_at = now(), last_seen_at = now();
  insert into public.membership_changes (user_id, from_player_id, to_player_id, reason)
  values (p_user_id, v_old_pid, v_code.player_id, 'recovery');
  update public.recovery_codes c set used_at = now(), used_by = p_user_id where c.id = v_code.id;
  insert into public.recovery_attempts (user_id, ip_hash, success) values (p_user_id, p_ip_hash, true);
  return jsonb_build_object('ok', true, 'player_id', v_code.player_id, 'previous_player_id', v_old_pid);
end;
$$;

create or replace function public.recovery_status(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'active', exists (select 1 from public.recovery_codes c where c.player_id = m.player_id
                       and c.used_at is null and c.revoked_at is null and c.expires_at > now()),
    'expires_at', (select max(c.expires_at) from public.recovery_codes c where c.player_id = m.player_id
                    and c.used_at is null and c.revoked_at is null and c.expires_at > now()),
    'devices', (select count(*) from public.player_members x where x.player_id = m.player_id))
    from public.player_members m where m.user_id = p_user_id
$$;

create or replace function public.recovery_revoke(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.recovery_codes c set revoked_at = now()
   where c.player_id = (select m.player_id from public.player_members m where m.user_id = p_user_id)
     and c.used_at is null and c.revoked_at is null;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'revoked', v_n);
end;
$$;

-- ---------------------------------------------------------------------
--  5. 維護（只給管理者在 SQL Editor 手動執行，前端不可呼叫）
--     刪除超過 p_days 天沒有使用、也沒有已開始存檔的匿名身分，以及沒有成員的空白玩家。
-- ---------------------------------------------------------------------
create or replace function public.mb_cleanup_stale_anonymous(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_cut timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 90), 7));
begin
  delete from auth.users u
   where u.is_anonymous
     and coalesce(u.last_sign_in_at, u.created_at) < v_cut
     and not exists (select 1 from public.player_members m
                       join public.game_saves g on g.player_id = m.player_id
                      where m.user_id = u.id and g.started);
  get diagnostics v_count = row_count;
  delete from public.players p
   where not exists (select 1 from public.player_members m where m.player_id = p.id)
     and not exists (select 1 from public.game_saves g where g.player_id = p.id and g.started)
     and p.created_at < v_cut;
  return v_count;
end;
$$;
