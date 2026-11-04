// ============================================================================
// FIREBASE CONFIG — connected to the "vhm-data" Firebase project.
//
// Make sure these are turned on for this project in the Firebase console
// (Build menu, left sidebar) — free tier is fine for all of them:
//   - Firestore Database (Build → Firestore Database → Create database)
//   - Storage             (Build → Storage → Get started)
//   - Authentication      (Build → Authentication → Get started →
//                          enable Email/Password → add staff accounts)
// Then publish firestore.rules and storage.rules (from this same folder)
// under Firestore → Rules and Storage → Rules in the console.
// ============================================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDxF04KvMQUg7kEQw4fFA4U_hiSoMyrUjs",
  authDomain: "vhm-data.firebaseapp.com",
  projectId: "vhm-data",
  storageBucket: "vhm-data.firebasestorage.app",
  messagingSenderId: "983915578738",
  appId: "1:983915578738:web:eb4b94478f1411a6c009eb",
};
