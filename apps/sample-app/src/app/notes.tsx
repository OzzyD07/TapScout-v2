import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Body, Button, Row, Screen, Title } from "../components/ui";
import { loadNotes, type Note } from "../lib/profile-store";
import { COPY, SEEDED } from "../lib/variant";

export default function Notes() {
  const [notes, setNotes] = useState<Note[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadNotes().then(setNotes);
    }, []),
  );

  return (
    <Screen testID="notes-screen">
      <Title>Your notes</Title>
      <Button testID="notes-add" label={COPY.addNote} onPress={() => router.push("/note-new")} />
      {notes && notes.length === 0 ? (
        <Body testID="notes-empty">No notes yet. Add your first field note.</Body>
      ) : null}
      {(notes ?? []).map((note, i) => (
        <Row
          key={note.id}
          testID={`note-row-${i}`}
          title={note.title}
          subtitle={note.body}
          clipTitle={SEEDED}
          onPress={() => router.push({ pathname: "/note/[id]", params: { id: note.id } })}
        />
      ))}
    </Screen>
  );
}
