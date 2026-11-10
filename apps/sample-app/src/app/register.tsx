import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { Body, Button, Field, Screen, Title } from "../components/ui";
import { addStarterNote, saveProfile, validateEmail } from "../lib/profile-store";
import { COPY, SEEDED } from "../lib/variant";

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [saving, setSaving] = useState(false);

  async function onContinue() {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Enter your name.";
    if (!validateEmail(email)) next.email = "Enter a valid email address.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    await saveProfile({ name: name.trim(), email: email.trim(), bio: "" });
    await addStarterNote();
    setSaving(false);
    router.replace("/profile");
  }

  return (
    <Screen testID="register-screen">
      <Title>Create your profile</Title>
      <Body>Your profile is stored only on this device.</Body>
      <Field
        testID="register-name"
        label="Name"
        value={name}
        onChangeText={setName}
        autoComplete="name"
        error={errors.name}
        returnKeyType="next"
      />
      <Field
        testID="register-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        error={errors.email}
        returnKeyType="done"
      />
      {SEEDED ? null : (
        <Button
          testID="register-continue"
          label={COPY.continue}
          onPress={onContinue}
          disabled={saving}
        />
      )}
      {/* Seeded defect: pinned to the bottom of the window, so the keyboard covers it. */}
      {SEEDED ? (
        <View style={{ position: "absolute", left: 20, right: 20, bottom: 24 }}>
          <Button
            testID="register-continue"
            label={COPY.continue}
            onPress={onContinue}
            disabled={saving}
          />
        </View>
      ) : null}
    </Screen>
  );
}
