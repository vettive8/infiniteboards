create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext unique,
  display_name text not null default 'User',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.boards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Infinite Paper',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.board_members (
  board_id uuid not null references public.boards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create table if not exists public.board_invites (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  email citext not null,
  role text not null default 'editor' check (role in ('editor')),
  invited_by uuid not null references public.profiles(id) on delete cascade,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (board_id, email)
);

create table if not exists public.notes (
  id uuid primary key,
  board_id uuid not null references public.boards(id) on delete cascade,
  type text not null check (type in ('text', 'image')),
  x integer not null default 0,
  y integer not null default 0,
  text text,
  image_path text,
  mime_type text,
  width integer,
  height integer,
  rotation numeric not null default 0,
  flip_x boolean not null default false,
  flip_y boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_board_id_idx on public.notes(board_id);
create index if not exists board_members_user_id_idx on public.board_members(user_id);
create index if not exists board_invites_email_idx on public.board_invites(email);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_profiles_updated_at on public.profiles;
create trigger touch_profiles_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists touch_boards_updated_at on public.boards;
create trigger touch_boards_updated_at
before update on public.boards
for each row execute function public.touch_updated_at();

drop trigger if exists touch_notes_updated_at on public.notes;
create trigger touch_notes_updated_at
before update on public.notes
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name', new.email, 'User')
  )
  on conflict (id) do update
  set email = excluded.email,
      display_name = coalesce(public.profiles.display_name, excluded.display_name),
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert or update on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_board_member(target_board_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.board_members bm
    where bm.board_id = target_board_id
      and bm.user_id = target_user_id
  );
$$;

create or replace function public.is_board_owner(target_board_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.board_members bm
    where bm.board_id = target_board_id
      and bm.user_id = target_user_id
      and bm.role = 'owner'
  );
$$;

create or replace function public.owns_board_record(target_board_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.boards b
    where b.id = target_board_id
      and b.owner_id = target_user_id
  );
$$;

create or replace function public.accept_pending_invites_for_current_user()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email citext;
begin
  select lower(email)::citext into current_email
  from auth.users
  where id = auth.uid();

  if current_email is null then
    return;
  end if;

  insert into public.board_members (board_id, user_id, role)
  select invite.board_id, auth.uid(), invite.role
  from public.board_invites invite
  where invite.email = current_email
    and invite.accepted_at is null
  on conflict (board_id, user_id) do update
  set role = excluded.role;

  update public.board_invites
  set accepted_at = now()
  where email = current_email
    and accepted_at is null;
end;
$$;

alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.board_members enable row level security;
alter table public.board_invites enable row level security;
alter table public.notes enable row level security;

drop policy if exists "profiles_select_self_or_board_members" on public.profiles;
create policy "profiles_select_self_or_board_members"
on public.profiles for select
to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.board_members self_member
    join public.board_members other_member on other_member.board_id = self_member.board_id
    where self_member.user_id = auth.uid()
      and other_member.user_id = profiles.id
  )
);

drop policy if exists "profiles_upsert_self" on public.profiles;
create policy "profiles_upsert_self"
on public.profiles for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "boards_select_members" on public.boards;
create policy "boards_select_members"
on public.boards for select
to authenticated
using (public.is_board_member(id));

drop policy if exists "boards_insert_owner" on public.boards;
create policy "boards_insert_owner"
on public.boards for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "boards_update_owner" on public.boards;
create policy "boards_update_owner"
on public.boards for update
to authenticated
using (public.is_board_owner(id))
with check (public.is_board_owner(id));

drop policy if exists "board_members_select_members" on public.board_members;
create policy "board_members_select_members"
on public.board_members for select
to authenticated
using (public.is_board_member(board_id));

drop policy if exists "board_members_insert_owner" on public.board_members;
create policy "board_members_insert_owner"
on public.board_members for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.owns_board_record(board_id)
);

drop policy if exists "board_members_delete_owner" on public.board_members;
create policy "board_members_delete_owner"
on public.board_members for delete
to authenticated
using (public.is_board_owner(board_id));

drop policy if exists "board_invites_select_related" on public.board_invites;
create policy "board_invites_select_related"
on public.board_invites for select
to authenticated
using (
  public.is_board_member(board_id)
  or email = lower((auth.jwt()->>'email'))::citext
);

drop policy if exists "board_invites_insert_owner" on public.board_invites;
create policy "board_invites_insert_owner"
on public.board_invites for insert
to authenticated
with check (public.is_board_owner(board_id) and invited_by = auth.uid());

drop policy if exists "board_invites_update_invitee" on public.board_invites;
create policy "board_invites_update_invitee"
on public.board_invites for update
to authenticated
using (public.is_board_owner(board_id) or email = lower((auth.jwt()->>'email'))::citext)
with check (public.is_board_owner(board_id) or email = lower((auth.jwt()->>'email'))::citext);

drop policy if exists "notes_select_members" on public.notes;
create policy "notes_select_members"
on public.notes for select
to authenticated
using (public.is_board_member(board_id));

drop policy if exists "notes_insert_members" on public.notes;
create policy "notes_insert_members"
on public.notes for insert
to authenticated
with check (public.is_board_member(board_id));

drop policy if exists "notes_update_members" on public.notes;
create policy "notes_update_members"
on public.notes for update
to authenticated
using (public.is_board_member(board_id))
with check (public.is_board_member(board_id));

drop policy if exists "notes_delete_members" on public.notes;
create policy "notes_delete_members"
on public.notes for delete
to authenticated
using (public.is_board_member(board_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'board-images',
  'board-images',
  false,
  15728640,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "board_images_select_members" on storage.objects;
create policy "board_images_select_members"
on storage.objects for select
to authenticated
using (
  bucket_id = 'board-images'
  and public.is_board_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "board_images_insert_members" on storage.objects;
create policy "board_images_insert_members"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'board-images'
  and public.is_board_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "board_images_update_members" on storage.objects;
create policy "board_images_update_members"
on storage.objects for update
to authenticated
using (
  bucket_id = 'board-images'
  and public.is_board_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'board-images'
  and public.is_board_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "board_images_delete_members" on storage.objects;
create policy "board_images_delete_members"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'board-images'
  and public.is_board_member(((storage.foldername(name))[1])::uuid)
);
