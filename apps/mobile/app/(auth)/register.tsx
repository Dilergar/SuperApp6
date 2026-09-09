import { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Link, router } from 'expo-router';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '../../src/stores/auth.store';

export default function RegisterScreen() {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const [phone, setPhone] = useState('+7');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const register = useAuthStore((s) => s.register);

  const handleRegister = async () => {
    if (!firstName.trim()) {
      Alert.alert(tc('state.error'), t('register.nameRequired'));
      return;
    }
    if (phone.length < 12) {
      Alert.alert(tc('state.error'), t('register.phoneInvalid'));
      return;
    }
    if (password.length < 8) {
      Alert.alert(tc('state.error'), t('register.passwordShort'));
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
        t('register.failed'),
        err.response?.data?.message || t('register.tryLater'),
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
        <Text style={styles.title}>{t('register.title')}</Text>
        <Text style={styles.subtitle}>{t('register.subtitleShort')}</Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder={t('register.firstNameRequiredPlaceholder')}
            placeholderTextColor="#666"
            value={firstName}
            onChangeText={setFirstName}
          />

          <TextInput
            style={styles.input}
            placeholder={t('register.lastNamePlaceholder')}
            placeholderTextColor="#666"
            value={lastName}
            onChangeText={setLastName}
          />

          <TextInput
            style={styles.input}
            placeholder={t('register.phonePlaceholder')}
            placeholderTextColor="#666"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
          />

          <TextInput
            style={styles.input}
            placeholder={t('register.passwordPlaceholder')}
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
              {loading ? t('register.creating') : t('register.createAccount')}
            </Text>
          </TouchableOpacity>
        </View>

        <Link href="/(auth)/login" style={styles.link}>
          <Text style={styles.linkText}>{t('register.haveAccountSignIn')}</Text>
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
