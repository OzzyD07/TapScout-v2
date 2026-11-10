import AsyncStorage from "@react-native-async-storage/async-storage";
import { SEEDED } from "./variant";

/** Local-only storage: resetting app data fully resets the sample (no remote backend). */
export interface Profile {
  name: string;
  email: string;
  bio: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

const PROFILE_KEY = "fieldnotes.profile.v1";
const NOTES_KEY = "fieldnotes.notes.v1";

/** Seeded defect: profile edits only live in memory and are gone after the app restarts. */
let unsavedEdit: Profile | null = null;

export async function loadProfile(): Promise<Profile | null> {
  if (unsavedEdit) return unsavedEdit;
  const raw = await AsyncStorage.getItem(PROFILE_KEY);
  return raw ? (JSON.parse(raw) as Profile) : null;
}

export async function saveProfile(profile: Profile): Promise<void> {
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

/** Saving from the edit screen; identical to saveProfile except in the seeded build. */
export async function updateProfile(profile: Profile): Promise<void> {
  if (SEEDED) {
    unsavedEdit = profile;
    return;
  }
  await saveProfile(profile);
}

export async function clearProfile(): Promise<void> {
  unsavedEdit = null;
  await AsyncStorage.removeItem(PROFILE_KEY);
}

export async function loadNotes(): Promise<Note[]> {
  const raw = await AsyncStorage.getItem(NOTES_KEY);
  return raw ? (JSON.parse(raw) as Note[]) : [];
}

export async function addNote(title: string, body: string): Promise<Note> {
  const notes = await loadNotes();
  const note: Note = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title,
    body,
    createdAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(NOTES_KEY, JSON.stringify([note, ...notes]));
  return note;
}

export async function deleteNote(id: string): Promise<void> {
  const notes = await loadNotes();
  await AsyncStorage.setItem(NOTES_KEY, JSON.stringify(notes.filter((n) => n.id !== id)));
}

/** A first note for new profiles, with a deliberately long title (list layout check). */
export const STARTER_NOTE = {
  title: "Welcome to FieldNotes: tap a note to read it, or add your own from this list",
  body: "Notes stay on this device. Delete this one from its detail screen.",
};

export async function addStarterNote(): Promise<void> {
  if ((await loadNotes()).length === 0) await addNote(STARTER_NOTE.title, STARTER_NOTE.body);
}

/** Account deletion: removes everything this app stored on the device. */
export async function deleteAccount(): Promise<void> {
  unsavedEdit = null;
  await AsyncStorage.multiRemove([PROFILE_KEY, NOTES_KEY]);
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
