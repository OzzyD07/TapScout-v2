import { router } from "expo-router";
import { Linking } from "react-native";
import { Body, Button, Screen, Title } from "../components/ui";
import { COPY, SEEDED } from "../lib/variant";

const PRIVACY_URL = "https://tap-scout-zeta.vercel.app/privacy";

export default function Settings() {
  return (
    <Screen testID="settings-screen">
      <Title>Settings</Title>
      <Body>FieldNotes keeps your profile and notes on this device only.</Body>
      <Button
        testID="settings-privacy"
        label={COPY.privacy}
        kind="secondary"
        onPress={() => Linking.openURL(PRIVACY_URL)}
      />
      {/* Seeded defect: no in-app way to delete the account that the app lets you create. */}
      {SEEDED ? null : (
        <Button
          testID="settings-delete-account"
          label={COPY.deleteAccount}
          kind="secondary"
          onPress={() => router.push("/delete-account")}
        />
      )}
      <Body>Version 1.0.0</Body>
    </Screen>
  );
}
