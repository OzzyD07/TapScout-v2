import type { ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useColorScheme,
  View,
} from "react-native";

export function useTheme() {
  const dark = useColorScheme() === "dark";
  return {
    dark,
    background: dark ? "#0f1115" : "#f7f7f9",
    card: dark ? "#1a1d24" : "#ffffff",
    text: dark ? "#f2f3f5" : "#14161a",
    muted: dark ? "#9aa1ad" : "#5c6370",
    border: dark ? "#2c313b" : "#dde0e6",
    accent: "#2f6fed",
    danger: "#d33f3f",
  };
}

export function Screen({ children, testID }: { children: ReactNode; testID: string }) {
  const t = useTheme();
  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: t.background }}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>
      {children}
    </Text>
  );
}

export function Body({ children, testID }: { children: ReactNode; testID?: string }) {
  const t = useTheme();
  return (
    <Text testID={testID} style={[styles.body, { color: t.muted }]}>
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  testID,
  kind = "primary",
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  kind?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const t = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? t.accent : "transparent",
          borderColor: primary ? t.accent : t.border,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? "#ffffff" : t.text }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  error,
  testID,
  ...input
}: TextInputProps & { label: string; error?: string | null; testID: string }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: t.text }]}>{label}</Text>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        style={[
          styles.input,
          { color: t.text, backgroundColor: t.card, borderColor: error ? t.danger : t.border },
        ]}
        {...input}
      />
      {error ? (
        <Text
          testID={`${testID}-error`}
          accessibilityLiveRegion="polite"
          style={[styles.error, { color: t.danger }]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Icon-only button (three bars). `accessibilityLabel` is required for screen readers; the seeded
 * build leaves it out on purpose.
 */
export function IconButton({
  testID,
  accessibilityLabel,
  onPress,
}: {
  testID: string;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        { borderColor: t.border, opacity: pressed ? 0.6 : 1 },
      ]}
    >
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.iconBar, { backgroundColor: t.text }]} />
      ))}
    </Pressable>
  );
}

/** Tappable list row with a title and an optional subtitle. */
export function Row({
  testID,
  title,
  subtitle,
  onPress,
  clipTitle = false,
}: {
  testID: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
  clipTitle?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: t.card, borderColor: t.border, opacity: pressed ? 0.8 : 1 },
        clipTitle ? styles.rowClipped : null,
      ]}
    >
      <Text style={[styles.rowTitle, { color: t.text }]}>{title}</Text>
      {subtitle ? (
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 16, flexGrow: 1 },
  title: { fontSize: 26, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: "600" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  error: { fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  iconBar: { width: 18, height: 2, borderRadius: 1 },
  row: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  rowClipped: { height: 48, overflow: "hidden" },
  rowTitle: { fontSize: 16, fontWeight: "600" },
});
