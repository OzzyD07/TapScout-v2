import AsyncStorage from "@react-native-async-storage/async-storage";
import demo from "./demo-account.json";
import { VARIANT } from "./variant";

/**
 * Sign-in of the `login` variant. The demo account is public (it is in this repository and is
 * given to TapScout as the build's test account); there is no backend, the check is local.
 */
export const SIGN_IN_REQUIRED = VARIANT === "login";

const SESSION_KEY = "fieldnotes.session.v1";

export async function isSignedIn(): Promise<boolean> {
  if (!SIGN_IN_REQUIRED) return true;
  return (await AsyncStorage.getItem(SESSION_KEY)) === "1";
}

export async function signIn(email: string, password: string): Promise<boolean> {
  const ok = email.trim().toLowerCase() === demo.email && password === demo.password;
  if (ok) await AsyncStorage.setItem(SESSION_KEY, "1");
  return ok;
}

export async function signOutSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}
