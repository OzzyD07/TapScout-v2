import { router } from "expo-router";
import { useState } from "react";
import { Body, Button, Screen, Title } from "../components/ui";
import { deleteAccount } from "../lib/profile-store";
import { signOutSession } from "../lib/session";

export default function DeleteAccount() {
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    setDeleting(true);
    await deleteAccount();
    await signOutSession();
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
  }

  return (
    <Screen testID="delete-account-screen">
      <Title>Delete your account</Title>
      <Body>
        This removes your profile and all notes from this device. There is no server copy, so this
        cannot be undone.
      </Body>
      <Button
        testID="delete-account-confirm"
        label="Delete my account"
        onPress={onDelete}
        disabled={deleting}
      />
      <Button
        testID="delete-account-cancel"
        label="Keep my account"
        kind="secondary"
        onPress={() => router.back()}
      />
    </Screen>
  );
}
