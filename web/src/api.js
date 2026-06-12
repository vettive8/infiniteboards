import { supabase } from "./supabaseClient.js";

const imageBucket = "board-images";

function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }
  return supabase;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function toDbNote(boardId, note, userId) {
  return {
    id: note.id,
    board_id: boardId,
    type: note.type === "image" ? "image" : "text",
    x: Math.round(Number(note.x) || 0),
    y: Math.round(Number(note.y) || 0),
    text: note.type === "image" ? null : note.text || "",
    image_path: note.type === "image" ? note.imagePath || `${boardId}/${note.imageId || note.id}` : null,
    mime_type: note.type === "image" ? note.mimeType || "image/png" : null,
    width: note.type === "image" ? Math.round(Number(note.width) || 320) : null,
    height: note.type === "image" ? Math.round(Number(note.height) || 180) : null,
    rotation: note.type === "image" ? Number(note.rotation) || 0 : 0,
    flip_x: note.type === "image" ? Boolean(note.flipX) : false,
    flip_y: note.type === "image" ? Boolean(note.flipY) : false,
    updated_by: userId,
  };
}

export function fromDbNote(row) {
  const base = {
    id: row.id,
    type: row.type === "image" ? "image" : "text",
    x: Math.round(Number(row.x) || 0),
    y: Math.round(Number(row.y) || 0),
  };

  if (base.type === "image") {
    const imagePath = row.image_path || "";
    return {
      ...base,
      imageId: imagePath.split("/").pop() || row.id,
      imagePath,
      mimeType: row.mime_type || "image/png",
      width: Math.round(Number(row.width) || 320),
      height: Math.round(Number(row.height) || 180),
      rotation: Number(row.rotation) || 0,
      flipX: Boolean(row.flip_x),
      flipY: Boolean(row.flip_y),
    };
  }

  return {
    ...base,
    text: row.text || "",
  };
}

export async function getSession() {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthStateChange(callback) {
  const client = requireSupabase();
  return client.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function signInWithGoogle() {
  const client = requireSupabase();
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signInWithMagicLink(email) {
  const client = requireSupabase();
  const { error } = await client.auth.signInWithOtp({
    email: normalizeEmail(email),
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
}

export async function signOut() {
  const client = requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export async function ensureProfile(user) {
  const client = requireSupabase();
  const { error } = await client.from("profiles").upsert(
    {
      id: user.id,
      email: normalizeEmail(user.email),
      display_name: user.user_metadata?.full_name || user.email || "User",
    },
    { onConflict: "id" }
  );
  if (error) throw error;
}

export async function acceptPendingInvites(user) {
  const client = requireSupabase();
  const email = normalizeEmail(user.email);
  if (!email) return;
  const { error } = await client.rpc("accept_pending_invites_for_current_user");
  if (error) throw error;
}

export async function listBoards() {
  const client = requireSupabase();
  const { data, error } = await client
    .from("boards")
    .select("id,title,owner_id,updated_at,board_members!inner(role)")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createBoard(title = "Infinite Paper") {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in.");

  const { data: board, error } = await client
    .from("boards")
    .insert({ title, owner_id: userId })
    .select("id,title,owner_id,updated_at")
    .single();
  if (error) throw error;

  const { error: memberError } = await client
    .from("board_members")
    .insert({ board_id: board.id, user_id: userId, role: "owner" });
  if (memberError) throw memberError;

  return board;
}

export async function getOrCreateDefaultBoard() {
  const boards = await listBoards();
  if (boards.length) {
    return boards[0];
  }
  return createBoard();
}

export async function loadNotes(boardId) {
  const client = requireSupabase();
  const { data, error } = await client.from("notes").select("*").eq("board_id", boardId);
  if (error) throw error;
  return (data || []).map(fromDbNote);
}

export async function saveNotes(boardId, notes, userId) {
  if (!notes.length) return;
  const client = requireSupabase();
  const rows = notes.map((note) => toDbNote(boardId, note, userId));
  const { error } = await client.from("notes").upsert(rows, { onConflict: "id" });
  if (error) throw error;
}

export async function deleteNotes(noteIds) {
  if (!noteIds.length) return;
  const client = requireSupabase();
  const { error } = await client.from("notes").delete().in("id", noteIds);
  if (error) throw error;
}

export async function uploadImage(boardId, imageId, blob) {
  const client = requireSupabase();
  const path = `${boardId}/${imageId}`;
  const { error } = await client.storage.from(imageBucket).upload(path, blob, {
    upsert: true,
    contentType: blob.type || "image/png",
  });
  if (error) throw error;
  return path;
}

export async function downloadImage(imagePath) {
  const client = requireSupabase();
  const { data, error } = await client.storage.from(imageBucket).download(imagePath);
  if (error) throw error;
  return data;
}

export async function removeImages(imagePaths) {
  const paths = imagePaths.filter(Boolean);
  if (!paths.length) return;
  const client = requireSupabase();
  const { error } = await client.storage.from(imageBucket).remove(paths);
  if (error) throw error;
}

export async function createInvite(boardId, email) {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError) throw userError;
  const { error } = await client.from("board_invites").upsert(
    {
      board_id: boardId,
      email: normalizeEmail(email),
      role: "editor",
      invited_by: userData.user.id,
    },
    { onConflict: "board_id,email" }
  );
  if (error) throw error;
}

export async function listBoardPeople(boardId) {
  const client = requireSupabase();
  const [{ data: members, error: memberError }, { data: invites, error: inviteError }] =
    await Promise.all([
      client
        .from("board_members")
        .select("role,profiles(email,display_name)")
        .eq("board_id", boardId)
        .order("role", { ascending: false }),
      client
        .from("board_invites")
        .select("email,role,accepted_at,created_at")
        .eq("board_id", boardId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false }),
    ]);
  if (memberError) throw memberError;
  if (inviteError) throw inviteError;
  return { members: members || [], invites: invites || [] };
}

export function subscribeToBoard(boardId, onChange) {
  const client = requireSupabase();
  const channel = client
    .channel(`board:${boardId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notes", filter: `board_id=eq.${boardId}` },
      onChange
    )
    .subscribe();

  return () => {
    client.removeChannel(channel);
  };
}

