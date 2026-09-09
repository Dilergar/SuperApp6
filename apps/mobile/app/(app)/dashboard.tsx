import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '../../src/stores/auth.store';
import { useFormatters } from '../../src/i18n/formatters';

// Реестр сервисов приложения пишется заново вместе с mobile (этап 2 дорожной карты);
// прежний общий MODULES из @superapp/shared удалён как мёртвый — на вебе реестр
// давно живёт в lib/app-nav.ts, и вторая копия только расходилась с ним.
const MODULES: { id: string; navKey: string }[] = [
  { id: 'circles', navKey: 'nav.circles' },
  { id: 'tasks', navKey: 'nav.tasks' },
  { id: 'calendar', navKey: 'nav.calendar' },
];

const ICON_MAP: Record<string, keyof typeof Ionicons.glyphMap> = {
  circles: 'people-outline',
  tasks: 'checkbox-outline',
  calendar: 'calendar-outline',
  finance: 'wallet-outline',
  coins: 'logo-bitcoin',
  shop: 'storefront-outline',
  chat: 'chatbubbles-outline',
  jobs: 'briefcase-outline',
};

const ROUTE_MAP: Record<string, string> = {
  circles: '/(app)/circles',
  tasks: '/(app)/tasks',
  calendar: '/(app)/calendar',
};

export default function DashboardScreen() {
  const t = useTranslations('dashboard');
  const tShell = useTranslations('shell');
  const tc = useTranslations('common');
  const f = useFormatters();
  const user = useAuthStore((s) => s.user);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Welcome header */}
      <View style={styles.header}>
        <Text style={styles.greeting}>
          {t('greeting.line', {
            greeting: t(`greeting.${greetingKey()}`),
            name: user?.firstName || tc('labels.someone'),
          })}
        </Text>
        <Text style={styles.date}>{f.date(new Date(), 'weekday')}</Text>
      </View>

      {/* Services grid */}
      <Text style={styles.sectionTitle}>{t('servicesTitle')}</Text>
      <View style={styles.grid}>
        {MODULES.map((mod) => (
          <TouchableOpacity
            key={mod.id}
            style={styles.serviceCard}
            onPress={() => {
              const route = ROUTE_MAP[mod.id];
              if (route) router.push(route as any);
            }}
          >
            <Ionicons
              name={ICON_MAP[mod.id] || 'apps-outline'}
              size={32}
              color="#6C5CE7"
            />
            <Text style={styles.serviceName}>{tShell(mod.navKey)}</Text>
          </TouchableOpacity>
        ))}

        {/* Placeholder for future modules */}
        <TouchableOpacity style={[styles.serviceCard, styles.serviceCardAdd]}>
          <Ionicons name="add-circle-outline" size={32} color="#444" />
          <Text style={[styles.serviceName, { color: '#444' }]}>{t('soon')}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

/** Время суток → ВЕТКА каталога: слово приветствия даёт `dashboard.greeting.*`. */
function greetingKey(): 'night' | 'morning' | 'day' | 'evening' {
  const hour = new Date().getHours();
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'day';
  return 'evening';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    padding: 20,
  },
  header: {
    marginBottom: 32,
  },
  greeting: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
  },
  date: {
    fontSize: 16,
    color: '#888',
    marginTop: 4,
    textTransform: 'capitalize',
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  serviceCard: {
    width: '47%',
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  serviceCardAdd: {
    borderStyle: 'dashed',
    borderColor: '#333',
    backgroundColor: 'transparent',
  },
  serviceName: {
    fontSize: 14,
    color: '#ccc',
    fontWeight: '500',
  },
});
