import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Banner, Button, Card } from '../components/ui';
import { colors, space } from '../theme';
import { SEED_DRIVERS, config } from '../config';
import { useSession } from '../session';

export function LoginScreen(): React.ReactElement {
  const { login, error, loading } = useSession();
  const [pending, setPending] = useState<string | null>(null);

  const enter = async (phone: string): Promise<void> => {
    setPending(phone);
    try {
      await login(phone);
    } catch {
      // El contexto ya publicó el mensaje en `error`.
    } finally {
      setPending(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.brand}>
        <View style={styles.orb} />
        <Text style={styles.title}>Orbit Conductor</Text>
      </View>
      <Text style={styles.sub}>Manejá con Orbit</Text>

      {error && <Banner text={error} tone="bad" />}

      <Card>
        <Text style={styles.cardTitle}>Entrar como</Text>
        <Text style={styles.cardHint}>
          Modo desarrollo. El plan de cada conductor define su comisión, y esa comisión
          se congela en el viaje al momento de aceptar.
        </Text>
        {SEED_DRIVERS.map((driver) => (
          <Button
            key={driver.phone}
            label={`${driver.label} · ${driver.plan}`}
            variant={driver.plan.startsWith('Pro') ? 'primary' : 'ghost'}
            onPress={() => void enter(driver.phone)}
            loading={pending === driver.phone && loading}
            disabled={pending !== null}
            style={styles.spaced}
          />
        ))}
      </Card>

      <Text style={styles.footer}>API: {config.apiUrl}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  orb: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.warn, borderWidth: 2, borderColor: colors.brand2 },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.dim, fontSize: 14, marginBottom: space.lg },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', marginBottom: space.xs },
  cardHint: { color: colors.dim, fontSize: 12, lineHeight: 17, marginBottom: space.lg },
  spaced: { marginBottom: space.sm },
  footer: { color: colors.dim2, fontSize: 11, marginTop: space.lg, textAlign: 'center' },
});
