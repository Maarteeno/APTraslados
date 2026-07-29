/** Piezas de UI compartidas. Sin librería externa: son cuatro componentes. */

import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { colors, radius, space } from '../theme';

export function Button({
  label, onPress, variant = 'primary', disabled = false, loading = false, style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  const blocked = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      // El feedback al tocar no es cosmético: sin él, en una red lenta el
      // usuario no sabe si el toque se registró y vuelve a apretar.
      style={({ pressed }) => [
        styles.button,
        variant === 'ghost' && styles.ghost,
        variant === 'danger' && styles.danger,
        pressed && styles.pressed,
        blocked && styles.blocked,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : colors.ink} />
      ) : (
        <Text style={[styles.buttonText, variant !== 'primary' && styles.buttonTextAlt]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }): React.ReactElement {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }): React.ReactElement {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.rowStrong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowStrong]}>{value}</Text>
    </View>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' | 'bad' }): React.ReactElement {
  const toneColor = tone === 'bad' ? colors.bad : tone === 'warn' ? colors.warn : colors.brand2;
  return (
    <View style={[styles.banner, { borderColor: toneColor }]}>
      <Text style={[styles.bannerText, { color: toneColor }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  ghost: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: '#5b2b33' },
  pressed: { opacity: 0.75 },
  blocked: { opacity: 0.45 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  buttonTextAlt: { color: colors.ink },
  card: {
    backgroundColor: colors.surface2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: space.lg,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm },
  rowLabel: { color: colors.dim, fontSize: 13 },
  rowValue: { color: colors.ink, fontSize: 13, fontVariant: ['tabular-nums'] },
  rowStrong: { color: colors.ink, fontWeight: '700', fontSize: 15 },
  banner: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  bannerText: { fontSize: 12.5, lineHeight: 18 },
});
