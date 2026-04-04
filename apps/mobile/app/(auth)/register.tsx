import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useAuthStore } from '../../src/stores/auth.store';

export default function RegisterScreen() {
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const register = useAuthStore((s) => s.register);

  const handleRegister = async () => {
    if (!firstName.trim()) {
      Alert.alert('Ошибка', 'Введите имя');
      return;
    }
    if (phone.length < 12) {
      Alert.alert('Ошибка', 'Введите корректный номер телефона');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Ошибка', 'Пароль должен быть минимум 8 символов');
      return;
    }

    setLoading(true);
    try {
      await register({
        phone,
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
      });
      router.replace('/(app)/dashboard');
    } catch (err: any) {
      Alert.alert(
        'Ошибка регистрации',
        err.response?.data?.error?.message || 'Попробуйте позже',
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
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Регистрация</Text>
        <Text style={styles.subtitle}>Создайте аккаунт SuperApp6</Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Имя *"
            placeholderTextColor="#666"
            value={firstName}
            onChangeText={setFirstName}
          />

          <TextInput
            style={styles.input}
            placeholder="Фамилия"
            placeholderTextColor="#666"
            value={lastName}
            onChangeText={setLastName}
          />

          <TextInput
            style={styles.input}
            placeholder="Номер телефона *"
            placeholderTextColor="#666"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />

          <TextInput
            style={styles.input}
            placeholder="Пароль (минимум 8 символов) *"
            placeholderTextColor="#666"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleRegister}
            disabled={loading}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Регистрация...' : 'Создать аккаунт'}
            </Text>
          </TouchableOpacity>
        </View>

        <Link href="/(auth)/login" style={styles.link}>
          <Text style={styles.linkText}>Уже есть аккаунт? Войти</Text>
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 40,
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
