// ============================================================================
// auth.js — sign-in / sign-out and auth-state watching.
// Kept separate from db.js so the login screen is its own concern.
// ============================================================================

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

// Reuse the same app instance db.js initializes (Firebase dedupes by config,
// but getApps() guards against double-init if both modules load).
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);

export function watchAuth(callback) {
  return onAuthStateChanged(auth, user => callback(user));
}

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}
