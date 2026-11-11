-- =====================================================================
--  晨光羈絆 Morning-Bond — 權限、RLS 與 Storage（policies.sql）
--  執行順序：先 schema.sql，再本檔。可重複執行。
--
--  原則
--  * anon（只有 Publishable key、尚未登入）完全不能讀寫遊戲資料。
--  * authenticated（包含匿名登入的玩家）只能存取「自己所屬玩家」的資料。
--  * 復原代碼相關資料表完全不開放給前端；只有 Edge Function（service role）能透過函式操作。
--  * 2026 年起 Supabase 不再自動把 public 的資料表授權給 API 角色，因此這裡全部明確 GRANT。
-- =====================================================================

-- ---------------------------------------------------------------------
--  1. 啟用 RLS（沒有對應 policy 的動作一律拒絕）
-- ---------------------------------------------------------------------
alter table public.players enable row level security;
alter table public.player_members enable row level security;
alter table public.game_saves enable row level security;
alter table public.save_snapshots enable row level security;
alter table public.memories enable row level security;
alter table public.recovery_codes enable row level security;
alter table public.recovery_attempts enable row level security;
alter table public.membership_changes enable row level security;

-- ---------------------------------------------------------------------
--  2. 資料表權限（GRANT）：先全部收回，再只給需要的
-- ---------------------------------------------------------------------
revoke all on public.players, public.player_members, public.game_saves, public.save_snapshots, public.memories,
              public.recovery_codes, public.recovery_attempts, public.membership_changes
  from anon, authenticated;

grant usage on schema public to authenticated, service_role;

grant select, delete on public.players to authenticated;
grant select on public.player_members to authenticated;
grant select, insert, update, delete on public.game_saves to authenticated;
grant select, delete on public.save_snapshots to authenticated;
grant select, insert, delete on public.memories to authenticated;

grant select, insert, update, delete on public.players, public.player_members, public.game_saves, public.save_snapshots,
                                        public.memories, public.recovery_codes, public.recovery_attempts, public.membership_changes
  to service_role;

-- ---------------------------------------------------------------------
--  3. RLS policies
-- ---------------------------------------------------------------------

-- players：只能看到／刪除自己（刪除＝刪掉全部雲端資料，會連帶刪除存檔、備份、回憶與裝置連結）
drop policy if exists "players_select_own" on public.players;
create policy "players_select_own" on public.players
  for select to authenticated
  using (id = (select public.mb_current_player_id()));
drop policy if exists "players_delete_own" on public.players;
create policy "players_delete_own" on public.players
  for delete to authenticated
  using (id = (select public.mb_current_player_id()));
-- INSERT / UPDATE：不開放（只能透過 ensure_player() 與觸發器）

-- player_members：可以看到同一位玩家的所有裝置；新增、修改、刪除只能透過伺服器端函式
drop policy if exists "members_select_same_player" on public.player_members;
create policy "members_select_same_player" on public.player_members
  for select to authenticated
  using (player_id = (select public.mb_current_player_id()));

-- game_saves：完整的 SELECT / INSERT / UPDATE / DELETE，只限自己的玩家
drop policy if exists "saves_select_own" on public.game_saves;
create policy "saves_select_own" on public.game_saves
  for select to authenticated
  using (player_id = (select public.mb_current_player_id()));
drop policy if exists "saves_insert_own" on public.game_saves;
create policy "saves_insert_own" on public.game_saves
  for insert to authenticated
  with check (player_id = (select public.mb_current_player_id()));
drop policy if exists "saves_update_own" on public.game_saves;
create policy "saves_update_own" on public.game_saves
  for update to authenticated
  using (player_id = (select public.mb_current_player_id()))
  with check (player_id = (select public.mb_current_player_id()));
drop policy if exists "saves_delete_own" on public.game_saves;
create policy "saves_delete_own" on public.game_saves
  for delete to authenticated
  using (player_id = (select public.mb_current_player_id()));

-- save_snapshots：可讀、可刪自己的備份；只能由觸發器建立，不可修改
drop policy if exists "snapshots_select_own" on public.save_snapshots;
create policy "snapshots_select_own" on public.save_snapshots
  for select to authenticated
  using (player_id = (select public.mb_current_player_id()));
drop policy if exists "snapshots_delete_own" on public.save_snapshots;
create policy "snapshots_delete_own" on public.save_snapshots
  for delete to authenticated
  using (player_id = (select public.mb_current_player_id()));

-- memories：可讀、可新增（只能加到自己的存檔）、可刪；不可修改（回憶只增不改）
drop policy if exists "memories_select_own" on public.memories;
create policy "memories_select_own" on public.memories
  for select to authenticated
  using (player_id = (select public.mb_current_player_id()));
drop policy if exists "memories_insert_own" on public.memories;
create policy "memories_insert_own" on public.memories
  for insert to authenticated
  with check (
    player_id = (select public.mb_current_player_id())
    and exists (select 1 from public.game_saves g where g.id = save_id and g.player_id = (select public.mb_current_player_id()))
  );
drop policy if exists "memories_delete_own" on public.memories;
create policy "memories_delete_own" on public.memories
  for delete to authenticated
  using (player_id = (select public.mb_current_player_id()));

-- recovery_codes / recovery_attempts / membership_changes：不建立任何 authenticated policy（全部拒絕）

-- ---------------------------------------------------------------------
--  4. 函式執行權限：預設 PUBLIC 可執行，先全部收回再逐一開放
-- ---------------------------------------------------------------------
revoke execute on function public.mb_current_player_id() from public, anon;
revoke execute on function public.mb_validate_state(jsonb) from public, anon, authenticated;
revoke execute on function public.mb_game_saves_before_write() from public, anon, authenticated;
revoke execute on function public.mb_extract_memories() from public, anon, authenticated;
revoke execute on function public.mb_photo_count(uuid) from public, anon;
revoke execute on function public.ensure_player(text) from public, anon;
revoke execute on function public.get_save_head(text) from public, anon;
revoke execute on function public.load_game_save(text) from public, anon;
revoke execute on function public.create_game_save(text, jsonb, text, text, text, uuid) from public, anon;
revoke execute on function public.update_game_save(uuid, jsonb, bigint, text, text, text, uuid) from public, anon;
revoke execute on function public.delete_game_save(uuid) from public, anon;
revoke execute on function public.list_save_snapshots(uuid) from public, anon;
revoke execute on function public.restore_game_save(uuid, uuid, bigint, text, uuid) from public, anon;
revoke execute on function public.list_memories(text, text, integer) from public, anon;
revoke execute on function public.list_player_devices() from public, anon;
revoke execute on function public.list_photo_paths_in_use() from public, anon;
revoke execute on function public.recovery_issue(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.recovery_redeem(uuid, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.recovery_status(uuid) from public, anon, authenticated;
revoke execute on function public.recovery_revoke(uuid) from public, anon, authenticated;
revoke execute on function public.mb_cleanup_stale_anonymous(integer) from public, anon, authenticated, service_role;

grant execute on function public.mb_current_player_id() to authenticated, service_role;
grant execute on function public.mb_photo_count(uuid) to authenticated, service_role;
grant execute on function public.ensure_player(text) to authenticated;
grant execute on function public.get_save_head(text) to authenticated;
grant execute on function public.load_game_save(text) to authenticated;
grant execute on function public.create_game_save(text, jsonb, text, text, text, uuid) to authenticated;
grant execute on function public.update_game_save(uuid, jsonb, bigint, text, text, text, uuid) to authenticated;
grant execute on function public.delete_game_save(uuid) to authenticated;
grant execute on function public.list_save_snapshots(uuid) to authenticated;
grant execute on function public.restore_game_save(uuid, uuid, bigint, text, uuid) to authenticated;
grant execute on function public.list_memories(text, text, integer) to authenticated;
grant execute on function public.list_player_devices() to authenticated;
grant execute on function public.list_photo_paths_in_use() to authenticated;
grant execute on function public.recovery_issue(uuid, text, integer) to service_role;
grant execute on function public.recovery_redeem(uuid, text, text, boolean) to service_role;
grant execute on function public.recovery_status(uuid) to service_role;
grant execute on function public.recovery_revoke(uuid) to service_role;

-- ---------------------------------------------------------------------
--  5. Storage：玩家照片（私有 bucket，每位玩家一個資料夾）
--     路徑格式：<player_id>/<hero|dad|mom|sis>-<16 碼 SHA-256 前綴>.<jpg|png|webp>
--     限制：單檔 1 MB、只收 JPEG／PNG／WebP、每位玩家最多 24 個檔案
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('player-photos', 'player-photos', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "mb_photos_select_own" on storage.objects;
create policy "mb_photos_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'player-photos'
    and (storage.foldername(name))[1] = (select public.mb_current_player_id())::text
  );

drop policy if exists "mb_photos_insert_own" on storage.objects;
create policy "mb_photos_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'player-photos'
    and (storage.foldername(name))[1] = (select public.mb_current_player_id())::text
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^(hero|dad|mom|sis)-[0-9a-f]{16}\.(jpg|png|webp)$'
    and public.mb_photo_count((select public.mb_current_player_id())) < 24
  );

drop policy if exists "mb_photos_update_own" on storage.objects;
create policy "mb_photos_update_own" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'player-photos'
    and (storage.foldername(name))[1] = (select public.mb_current_player_id())::text
  )
  with check (
    bucket_id = 'player-photos'
    and (storage.foldername(name))[1] = (select public.mb_current_player_id())::text
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^(hero|dad|mom|sis)-[0-9a-f]{16}\.(jpg|png|webp)$'
  );

drop policy if exists "mb_photos_delete_own" on storage.objects;
create policy "mb_photos_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'player-photos'
    and (storage.foldername(name))[1] = (select public.mb_current_player_id())::text
  );
