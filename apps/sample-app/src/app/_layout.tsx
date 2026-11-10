import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack>
        <Stack.Screen name="index" options={{ title: "FieldNotes" }} />
        <Stack.Screen name="sign-in" options={{ title: "Sign in", headerBackVisible: false }} />
        <Stack.Screen name="register" options={{ title: "Create profile" }} />
        <Stack.Screen name="profile" options={{ title: "Profile", headerBackVisible: false }} />
        <Stack.Screen name="edit-profile" options={{ title: "Edit profile" }} />
        <Stack.Screen name="notes" options={{ title: "Notes" }} />
        <Stack.Screen name="note-new" options={{ title: "New note" }} />
        <Stack.Screen name="note/[id]" options={{ title: "Note" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="delete-account" options={{ title: "Delete account" }} />
      </Stack>
    </>
  );
}
