import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { Body, Button, Card, Screen, Title, useTheme } from "../../components/ui";
import { deleteNote, loadNotes, type Note } from "../../lib/profile-store";

export default function NoteDetail() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [note, setNote] = useState<Note | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    loadNotes().then((notes) => setNote(notes.find((n) => n.id === id) ?? null));
  }, [id]);

  async function onDelete() {
    if (!note) return;
    await deleteNote(note.id);
    router.back();
  }

  if (note === null) {
    return (
      <Screen testID="note-missing-screen">
        <Body>This note no longer exists.</Body>
      </Screen>
    );
  }

  return (
    <Screen testID="note-screen">
      <Title>{note?.title ?? ""}</Title>
      <Card>
        <Text testID="note-detail-body" style={{ color: t.text, fontSize: 16 }}>
          {note?.body || "No text."}
        </Text>
      </Card>
      {confirming ? (
        <>
          <Body>Delete this note? This cannot be undone.</Body>
          <Button testID="note-delete-confirm" label="Delete" onPress={onDelete} />
          <Button
            testID="note-delete-cancel"
            label="Cancel"
            kind="secondary"
            onPress={() => setConfirming(false)}
          />
        </>
      ) : (
        <Button
          testID="note-delete"
          label="Delete note"
          kind="secondary"
          onPress={() => setConfirming(true)}
        />
      )}
    </Screen>
  );
}
