import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useAuthStore } from '../../src/stores/auth.store';

export default function LoginScreen() {
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);

  const handleLogin = async () => {
    if (phone.length < 12 || password.length < 8) {
      Alert.alert('Ошибка', 'Проверьте номер телефона и пароль');
      return;
    }

    setLoading(true);
    try {
      await login(phone, password);
      router.replace('/(app)/dashboard');
    } catch (err: any) {
      Alert.alert(
        'Ошибка входа',
        err.response?.data?.error?.message || 'Неверный номер или пароль',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        <Text style={styles.logo}>SuperApp6</Text>
        <Text style={styles.subtitle}>Одно приложение для всего</Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Номер телефона"
            placeholderTextColor="#666"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            autoComplete="tel"
          />

          <TextInput
            style={styles.input}
            placeholder="Пароль"
            placeholderTextColor="#666"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Вход...' : 'Войти'}
            </Text>
          </TouchableOpacity>
        </View>

        <Link href="/(auth)/register" style={styles.link}>
          <Text style={styles.linkText}>Нет аккаунта? Регистрация</Text>
        </Link>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logo: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#6C5CE7',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 48,
  },
  form: {
    gap: 16,
  },
  input: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#2a2a4a',
  },
  button: {
    backgroundColor: '#6C5CE7',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  link: {
    marginTop: 24,
    alignSelf: 'center',
  },
  linkText: {
    color: '#6C5CE7',
    fontSize: 14,
  },
});
