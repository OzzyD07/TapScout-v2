import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Button, Field, Screen } from "../components/ui";
import { loadProfile, type Profile, updateProfile } from "../lib/profile-store";
import { COPY } from "../lib/variant";

export default function EditProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    loadProfile().then((p) => {
      setProfile(p);
      setName(p?.name ?? "");
      setBio(p?.bio ?? "");
    });
  }, []);

  async function onSave() {
    if (!name.trim()) {
      setNameError("Name cannot be empty.");
      return;
    }
    setNameError(null);
    if (!profile) return;
    await updateProfile({ ...profile, name: name.trim(), bio: bio.trim() });
    router.back();
  }

  return (
    <Screen testID="edit-profile-screen">
      <Field
        testID="edit-name"
        label="Name"
        value={name}
        onChangeText={setName}
        error={nameError}
      />
      <Field
        testID="edit-bio"
        label="About you"
        value={bio}
        onChangeText={setBio}
        multiline
        maxLength={280}
        style={{ minHeight: 96, textAlignVertical: "top" }}
      />
      <Button testID="edit-save" label={COPY.save} onPress={onSave} disabled={!profile} />
    </Screen>
  );
}
