import { router } from "expo-router";
import { useState } from "react";
import { Body, Button, Field, Screen, Title } from "../components/ui";
import { signIn } from "../lib/session";

/** Only in the `login` variant: the app is usable after signing in with the demo account. */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSignIn() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    const ok = await signIn(email, password);
    setBusy(false);
    if (!ok) {
      setError("Email or password is incorrect.");
      return;
    }
    setError(null);
    router.replace("/");
  }

  return (
    <Screen testID="sign-in-screen">
      <Title>Sign in to FieldNotes</Title>
      <Body>Use the account your team gave you.</Body>
      <Field
        testID="sign-in-email"
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        // No password-manager prompts: they would open system dialogs over the app under test.
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        returnKeyType="next"
      />
      <Field
        testID="sign-in-password"
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        error={error}
        returnKeyType="done"
        onSubmitEditing={onSignIn}
      />
      <Button testID="sign-in-submit" label="Sign in" onPress={onSignIn} disabled={busy} />
      <Button
        testID="sign-in-forgot"
        label="Forgot password?"
        kind="secondary"
        onPress={() => setHelp(true)}
      />
      {help ? <Body testID="sign-in-help">Ask your team admin to reset your password.</Body> : null}
    </Screen>
  );
}
