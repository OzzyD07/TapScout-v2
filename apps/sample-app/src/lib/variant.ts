/**
 * Build variant, inlined at bundle time from EXPO_PUBLIC_APP_VARIANT.
 * - seeded:       demo build with intentional defects (listed only in quality/ground-truth)
 * - fixed:        healthy control build
 * - changed_flow: same features with changed labels/order/layout, to test fresh exploration
 * - login:        the healthy build behind a sign-in screen (demo account in demo-account.json)
 *
 * Nothing in the UI reveals the variant; the agent must not be able to read it.
 */
export type Variant = "seeded" | "fixed" | "changed_flow" | "login";

const raw = process.env.EXPO_PUBLIC_APP_VARIANT;

export const VARIANT: Variant =
  raw === "seeded" || raw === "changed_flow" || raw === "login" ? raw : "fixed";

/** Behaviour switches of the seeded build; each one is a ground-truth entry. */
export const SEEDED = VARIANT === "seeded";

const FIXED_COPY = {
  getStarted: "Get started",
  continue: "Continue",
  editProfile: "Edit profile",
  notes: "My notes",
  addNote: "Add note",
  save: "Save",
  signOut: "Sign out",
  privacy: "Privacy policy",
  deleteAccount: "Delete account",
};

const CHANGED_COPY: typeof FIXED_COPY = {
  getStarted: "Start",
  continue: "Next",
  editProfile: "Edit",
  notes: "Notes",
  addNote: "New note",
  save: "Done",
  signOut: "Log out",
  privacy: "Privacy",
  deleteAccount: "Remove account",
};

/** User-visible labels; changed_flow renames them so stored paths cannot simply be replayed. */
export const COPY = VARIANT === "changed_flow" ? CHANGED_COPY : FIXED_COPY;
