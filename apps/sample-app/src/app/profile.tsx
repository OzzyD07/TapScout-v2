import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Body, Button, Card, IconButton, Screen, Title, useTheme } from "../components/ui";
import { clearProfile, loadProfile, type Profile } from "../lib/profile-store";
import { signOutSession } from "../lib/session";
import { COPY, SEEDED, VARIANT } from "../lib/variant";

export default function ProfileScreen() {
  const t = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadProfile().then(setProfile);
    }, []),
  );

  async function onSignOut() {
    await clearProfile();
    await signOutSession();
    router.replace("/");
  }

  return (
    <Screen testID="profile-screen">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Title>{profile ? `Hi, ${profile.name}` : "Profile"}</Title>
        <IconButton
          testID="profile-settings"
          accessibilityLabel={SEEDED ? undefined : "Settings"}
          onPress={() => router.push("/settings")}
        />
      </View>
      <Card>
        <Text style={{ color: t.muted, fontSize: 13 }}>Email</Text>
        <Text testID="profile-email" style={{ color: t.text, fontSize: 16 }}>
          {profile?.email ?? "—"}
        </Text>
        <Text style={{ color: t.muted, fontSize: 13, marginTop: 8 }}>About</Text>
        <Text testID="profile-bio" style={{ color: t.text, fontSize: 16 }}>
          {profile?.bio || "No bio yet."}
        </Text>
      </Card>
      <Body>Changes are saved on this device.</Body>
      {VARIANT === "changed_flow" ? (
        <>
          <Button testID="profile-notes" label={COPY.notes} onPress={() => router.push("/notes")} />
          <Button
            testID="profile-edit"
            label={COPY.editProfile}
            kind="secondary"
            onPress={() => router.push("/edit-profile")}
          />
        </>
      ) : (
        <>
          <Button
            testID="profile-edit"
            label={COPY.editProfile}
            onPress={() => router.push("/edit-profile")}
          />
          <Button testID="profile-notes" label={COPY.notes} onPress={() => router.push("/notes")} />
        </>
      )}
      <Button testID="profile-sign-out" label={COPY.signOut} kind="secondary" onPress={onSignOut} />
    </Screen>
  );
}
