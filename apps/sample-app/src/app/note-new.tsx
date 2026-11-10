import { router } from "expo-router";
import { useState } from "react";
import { Button, Field, Screen } from "../components/ui";
import { addNote } from "../lib/profile-store";
import { COPY, SEEDED } from "../lib/variant";

export default function NewNote() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function onSave() {
    // Seeded defect: a long title throws inside the press handler, which crashes a release build.
    if (SEEDED && title.length > 120) {
      throw new Error("Note title is too long for the list layout");
    }
    if (!title.trim()) {
      setError("Give the note a title.");
      return;
    }
    setError(null);
    setSaving(true);
    addNote(title.trim(), body.trim()).then(() => {
      setSaving(false);
      router.back();
    });
  }

  return (
    <Screen testID="note-new-screen">
      <Field
        testID="note-title"
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={error}
        maxLength={SEEDED ? undefined : 120}
      />
      <Field
        testID="note-body"
        label="Note"
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={1000}
        style={{ minHeight: 120, textAlignVertical: "top" }}
      />
      <Button testID="note-save" label={COPY.save} onPress={onSave} disabled={saving} />
    </Screen>
  );
}
