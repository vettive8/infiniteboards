import "./styles.css";
import { hasSupabaseConfig, supabase } from "./supabaseClient.js";
import * as api from "./api.js";
import { createBoardApp } from "./boardApp.js";

const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");
const authMessage = document.getElementById("auth-message");
const googleLogin = document.getElementById("google-login");
const magicLinkForm = document.getElementById("magic-link-form");
const magicLinkEmail = document.getElementById("magic-link-email");
const signOutButton = document.getElementById("sign-out");

let boardApp = null;
let authSubscription = null;
let activeUserId = "";

function showAuth(message = "") {
  authScreen.hidden = false;
  appShell.hidden = true;
  authMessage.textContent = message;
}

function showApp() {
  authScreen.hidden = true;
  appShell.hidden = false;
}

async function bootSession(session) {
  if (!session?.user) {
    showAuth();
    boardApp?.destroy?.();
    boardApp = null;
    activeUserId = "";
    return;
  }

  if (boardApp && activeUserId === session.user.id) {
    showApp();
    return;
  }

  showApp();
  await api.ensureProfile(session.user);
  await api.acceptPendingInvites(session.user);
  const board = await api.getOrCreateDefaultBoard();

  boardApp?.destroy?.();
  boardApp = createBoardApp({
    api,
    session,
    board,
  });
  activeUserId = session.user.id;
  await boardApp.start();
}

async function boot() {
  if (!hasSupabaseConfig) {
    showAuth("Missing Supabase config. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.");
    googleLogin.disabled = true;
    magicLinkForm.querySelector("button").disabled = true;
    return;
  }

  googleLogin.addEventListener("click", () => {
    authMessage.textContent = "Opening Google sign-in...";
    api.signInWithGoogle().catch((error) => {
      authMessage.textContent = error.message;
    });
  });

  magicLinkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    authMessage.textContent = "Sending sign-in link...";
    api
      .signInWithMagicLink(magicLinkEmail.value)
      .then(() => {
        authMessage.textContent = "Check your email for the sign-in link.";
      })
      .catch((error) => {
        authMessage.textContent = error.message;
      });
  });

  signOutButton.addEventListener("click", () => {
    api.signOut().catch(() => {});
  });

  authSubscription = api.onAuthStateChange((session) => {
    bootSession(session).catch((error) => showAuth(error.message));
  });

  const session = await api.getSession();
  await bootSession(session);
}

window.addEventListener("beforeunload", () => {
  authSubscription?.data?.subscription?.unsubscribe?.();
  supabase?.removeAllChannels?.();
});

boot().catch((error) => showAuth(error.message));
