import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/stores/auth.store';
import { formatPhone } from '@superapp/shared';

export default function ProfileScreen() {
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    Alert.alert('Выход', 'Вы уверены что хотите выйти?', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Выйти',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user?.firstName?.[0]?.toUpperCase() || '?'}
          </Text>
        </View>
        <Text style={styles.name}>
          {user?.firstName} {user?.lastName || ''}
        </Text>
        <Text style={styles.phone}>
          {user?.phone ? formatPhone(user.phone) : ''}
        </Text>
      </View>

      {/* Menu items */}
      <View style={styles.menu}>
        <MenuItem icon="person-outline" label="Редактировать профиль" />
        <MenuItem icon="notifications-outline" label="Уведомления" />
        <MenuItem icon="shield-outline" label="Безопасность" />
        <MenuItem icon="color-palette-outline" label="Оформление" />
        <MenuItem icon="language-outline" label="Язык" value="Русский" />
        <MenuItem icon="card-outline" label="Подписка" value="Пробный период" />
        <MenuItem icon="phone-portrait-outline" label="Активные сессии" />
      </View>

      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={20} color="#E74C3C" />
        <Text style={styles.logoutText}>Выйти из аккаунта</Text>
      </TouchableOpacity>

      <Text style={styles.version}>SuperApp6 v0.1.0</Text>
    </View>
  );
}

function MenuItem({ icon, label, value }: { icon: string; label: string; value?: string }) {
  return (
    <TouchableOpacity style={styles.menuItem}>
      <Ionicons name={icon as any} size={22} color="#6C5CE7" />
      <Text style={styles.menuLabel}>{label}</Text>
      {value && <Text style={styles.menuValue}>{value}</Text>}
      <Ionicons name="chevron-forward" size={18} color="#444" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  avatarSection: { alignItems: 'center', paddingVertical: 32 },
  avatar: {
    width: 80, height: 80, borderRadius: 40, backgroundColor: '#6C5CE7',
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  avatarText: { fontSize: 32, fontWeight: 'bold', color: '#fff' },
  name: { fontSize: 22, fontWeight: '600', color: '#fff' },
  phone: { fontSize: 15, color: '#888', marginTop: 4 },
  menu: {
    backgroundColor: '#16213e', marginHorizontal: 16, borderRadius: 16,
    borderWidth: 1, borderColor: '#2a2a4a',
  },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', padding: 16, gap: 14,
    borderBottomWidth: 1, borderBottomColor: '#2a2a4a',
  },
  menuLabel: { flex: 1, fontSize: 16, color: '#fff' },
  menuValue: { fontSize: 14, color: '#888' },
  logoutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 32, padding: 16,
  },
  logoutText: { fontSize: 16, color: '#E74C3C' },
  version: { textAlign: 'center', color: '#444', fontSize: 13, marginTop: 16 },
});
