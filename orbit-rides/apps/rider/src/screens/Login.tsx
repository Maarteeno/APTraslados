import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card } from '../components/ui';
import { colors, radius, space } from '../theme';
import { SEED_RIDERS, config } from '../config';
import { useSession } from '../session';

/**
 * Login de desarrollo.
 *
 * Botones con los teléfonos del seed en vez de un teclado: en desarrollo se
 * entra veinte veces por hora y escribir +598... cada vez es fricción sin
 * sentido. Cuando exista Firebase, esto se reemplaza por teléfono + OTP.
 */
export function LoginScreen(): React.ReactElement {
  const { login, error, loading } = useSession();
  const [pending, setPending] = useState<string | null>(null);

  const enter = async (phone: string): Promise<void> => {
    setPending(phone);
    try {
      await login(phone);
    } catch {
      // El mensaje ya lo publica el contexto en `error`.
    } finally {
      setPending(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.brand}>
        <View style={styles.orb} />
        <Text style={styles.title}>Orbit Rides</Text>
      </View>
      <Text style={styles.sub}>Viajes en Montevideo</Text>

      {error && <Banner text={error} tone="bad" />}

      <Card>
        <Text style={styles.cardTitle}>Entrar como</Text>
        <Text style={styles.cardHint}>
          Modo desarrollo. El API firma sus propios tokens y su configuración prohíbe
          este modo en producción.
        </Text>
        {SEED_RIDERS.map((user) => (
          <Button
            key={user.phone}
            label={`${user.label} · ${user.role}`}
            variant={user.role === 'pasajero' ? 'primary' : 'ghost'}
            onPress={() => void enter(user.phone)}
            loading={pending === user.phone && loading}
            disabled={pending !== null}
            style={styles.spaced}
          />
        ))}
      </Card>

      <Text style={styles.footer}>API: {config.apiUrl}</Text>
      <Text style={styles.footerDim}>
        Si dice «no se pudo conectar», revisá que el backend esté arriba y que la URL
        use 10.0.2.2 y no localhost.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  orb: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: colors.brand,
    borderWidth: 2, borderColor: colors.brand2,
  },
  title: { color: colors.ink, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.dim, fontSize: 14, marginBottom: space.lg },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', marginBottom: space.xs },
  cardHint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginBottom: space.lg },
  spaced: { marginBottom: space.sm },
  footer: { color: colors.dim2, fontSize: 11, marginTop: space.lg, textAlign: 'center' },
  footerDim: { color: colors.dim2, fontSize: 10.5, textAlign: 'center', lineHeight: 15, borderRadius: radius.sm },
});
