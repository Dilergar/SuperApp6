import { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Alert, Modal,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/lib/api';
import { CIRCLE_ROLE_SUGGESTIONS } from '@superapp/shared';

export default function CirclesScreen() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCircleName, setNewCircleName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['circles'],
    queryFn: async () => {
      const res = await api.get('/circles');
      return res.data.data;
    },
  });

  const createCircle = useMutation({
    mutationFn: async (name: string) => {
      const res = await api.post('/circles', { name });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['circles'] });
      setShowCreateModal(false);
      setNewCircleName('');
    },
    onError: () => Alert.alert('Ошибка', 'Не удалось создать окружение'),
  });

  const circles = data || [];

  return (
    <View style={styles.container}>
      <FlatList
        data={circles}
        keyExtractor={(item: any) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }: { item: any }) => (
          <TouchableOpacity style={styles.circleCard}>
            <View style={[styles.circleIcon, { backgroundColor: item.color || '#6C5CE7' }]}>
              <Text style={styles.circleEmoji}>{item.icon || '👥'}</Text>
            </View>
            <View style={styles.circleInfo}>
              <Text style={styles.circleName}>{item.name}</Text>
              <Text style={styles.circleCount}>
                {item._count?.members || 0} участников
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#666" />
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color="#333" />
            <Text style={styles.emptyText}>
              {isLoading ? 'Загрузка...' : 'Создайте первое окружение'}
            </Text>
            <Text style={styles.emptyHint}>
              Например: Семья, Друзья, Коллеги
            </Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.suggestionsBlock}>
            <Text style={styles.suggestLabel}>Доступные роли:</Text>
            <View style={styles.roleSuggestions}>
              {CIRCLE_ROLE_SUGGESTIONS.map((role) => (
                <View key={role} style={styles.roleChip}>
                  <Text style={styles.roleChipText}>{role}</Text>
                </View>
              ))}
            </View>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowCreateModal(true)}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      {/* Create Modal */}
      <Modal visible={showCreateModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Новое окружение</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Название (например: Семья)"
              placeholderTextColor="#666"
              value={newCircleName}
              onChangeText={setNewCircleName}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowCreateModal(false)}
              >
                <Text style={styles.modalCancelText}>Отмена</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCreate}
                onPress={() => {
                  if (newCircleName.trim()) createCircle.mutate(newCircleName.trim());
                }}
              >
                <Text style={styles.modalCreateText}>Создать</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  list: { padding: 16, gap: 8 },
  circleCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#16213e',
    borderRadius: 16, padding: 16, gap: 14,
    borderWidth: 1, borderColor: '#2a2a4a',
  },
  circleIcon: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
  },
  circleEmoji: { fontSize: 22 },
  circleInfo: { flex: 1 },
  circleName: { fontSize: 17, fontWeight: '600', color: '#fff' },
  circleCount: { fontSize: 13, color: '#888', marginTop: 2 },
  empty: { alignItems: 'center', paddingTop: 80, gap: 8 },
  emptyText: { color: '#666', fontSize: 16 },
  emptyHint: { color: '#444', fontSize: 14 },
  suggestionsBlock: { marginTop: 32, padding: 4 },
  suggestLabel: { color: '#888', fontSize: 14, marginBottom: 8 },
  roleSuggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roleChip: {
    backgroundColor: '#16213e', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6,
    borderWidth: 1, borderColor: '#2a2a4a',
  },
  roleChipText: { color: '#ccc', fontSize: 13 },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#6C5CE7', alignItems: 'center', justifyContent: 'center',
    elevation: 4,
    shadowColor: '#6C5CE7', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8,
  },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#16213e', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24,
  },
  modalTitle: { fontSize: 20, fontWeight: '600', color: '#fff', marginBottom: 16 },
  modalInput: {
    backgroundColor: '#1a1a2e', borderRadius: 12, padding: 14,
    fontSize: 16, color: '#fff', borderWidth: 1, borderColor: '#2a2a4a',
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 20 },
  modalCancel: { padding: 12 },
  modalCancelText: { color: '#888', fontSize: 16 },
  modalCreate: { backgroundColor: '#6C5CE7', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  modalCreateText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
