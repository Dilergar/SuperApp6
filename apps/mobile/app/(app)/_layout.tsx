import { Tabs } from 'expo-router';
import { useTranslations } from 'use-intl';
import { Ionicons } from '@expo/vector-icons';

export default function AppLayout() {
  const tShell = useTranslations('shell');
  const tProfile = useTranslations('profile');
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#1a1a2e' },
        headerTintColor: '#fff',
        tabBarStyle: {
          backgroundColor: '#1a1a2e',
          borderTopColor: '#2a2a4a',
        },
        tabBarActiveTintColor: '#6C5CE7',
        tabBarInactiveTintColor: '#666',
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: tShell('nav.dashboard'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: tShell('nav.tasks'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="checkbox-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: tShell('nav.calendar'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="circles"
        options={{
          title: tShell('nav.circles'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: tProfile('title'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
