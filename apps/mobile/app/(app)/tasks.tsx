import { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  TextInput, Alert,
} from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/lib/api';

const STATUS_COLORS: Record<string, string> = {
  todo: '#888',
  in_progress: '#F39C12',
  done: '#27AE60',
  cancelled: '#E74C3C',
};

const PRIORITY_ICONS: Record<string, { icon: string; color: string }> = {
  low: { icon: 'arrow-down', color: '#888' },
  medium: { icon: 'remove', color: '#F39C12' },
  high: { icon: 'arrow-up', color: '#E67E22' },
  urgent: { icon: 'alert-circle', color: '#E74C3C' },
};

export default function TasksScreen() {
  const queryClient = useQueryClient();
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [filter, setFilter] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['tasks', filter],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filter) params.status = filter;
      const res = await api.get('/tasks', { params });
      return res.data;
    },
  });

  const createTask = useMutation({
    mutationFn: async (title: string) => {
      const res = await api.post('/tasks', { title });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setNewTaskTitle('');
    },
    onError: () => Alert.alert('Ошибка', 'Не удалось создать задачу'),
  });

  const toggleStatus = useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: string }) => {
      const newStatus = currentStatus === 'done' ? 'todo' : 'done';
      return api.patch(`/tasks/${id}`, { status: newStatus });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const tasks = data?.data || [];
  const filters = [
    { key: null, label: 'Все' },
    { key: 'todo', label: 'К выполнению' },
    { key: 'in_progress', label: 'В работе' },
    { key: 'done', label: 'Готово' },
  ];

  return (
    <View style={styles.container}>
      {/* Quick add */}
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="Новая задача..."
          placeholderTextColor="#666"
          value={newTaskTitle}
          onChangeText={setNewTaskTitle}
          onSubmitEditing={() => {
            if (newTaskTitle.trim()) createTask.mutate(newTaskTitle.trim());
          }}
        />
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => {
            if (newTaskTitle.trim()) createTask.mutate(newTaskTitle.trim());
          }}
        >
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Filters */}
      <View style={styles.filters}>
        {filters.map((f) => (
          <TouchableOpacity
            key={f.key ?? 'all'}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Tasks list */}
      <FlatList
        data={tasks}
        keyExtractor={(item: any) => item.id}
        renderItem={({ item }: { item: any }) => (
          <TouchableOpacity style={styles.taskItem}>
            <TouchableOpacity
              style={[
                styles.checkbox,
                item.status === 'done' && styles.checkboxDone,
              ]}
              onPress={() => toggleStatus.mutate({ id: item.id, currentStatus: item.status })}
            >
              {item.status === 'done' && (
                <Ionicons name="checkmark" size={16} color="#fff" />
              )}
            </TouchableOpacity>

            <View style={styles.taskContent}>
              <Text style={[styles.taskTitle, item.status === 'done' && styles.taskTitleDone]}>
                {item.title}
              </Text>
              <View style={styles.taskMeta}>
                {item.assignee && (
                  <Text style={styles.taskAssignee}>
                    {item.assignee.firstName}
                  </Text>
                )}
                {item.dueDate && (
                  <Text style={styles.taskDue}>
                    {new Date(item.dueDate).toLocaleDateString('ru-RU')}
                  </Text>
                )}
                {item.coinReward > 0 && (
                  <Text style={styles.taskCoins}>+{item.coinReward} coin</Text>
                )}
              </View>
            </View>

            <View style={styles.taskRight}>
              <Ionicons
                name={(PRIORITY_ICONS[item.priority]?.icon || 'remove') as any}
                size={16}
                color={PRIORITY_ICONS[item.priority]?.color || '#888'}
              />
              {item.subtasksCount > 0 && (
                <Text style={styles.subtaskCount}>
                  {item.subtasksDoneCount}/{item.subtasksCount}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="checkbox-outline" size={48} color="#333" />
            <Text style={styles.emptyText}>
              {isLoading ? 'Загрузка...' : 'Нет задач'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  addRow: { flexDirection: 'row', padding: 16, gap: 8 },
  addInput: {
    flex: 1, backgroundColor: '#16213e', borderRadius: 12, padding: 14,
    fontSize: 16, color: '#fff', borderWidth: 1, borderColor: '#2a2a4a',
  },
  addButton: {
    backgroundColor: '#6C5CE7', borderRadius: 12, width: 48, alignItems: 'center',
    justifyContent: 'center',
  },
  filters: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: '#16213e', borderWidth: 1, borderColor: '#2a2a4a',
  },
  filterChipActive: { backgroundColor: '#6C5CE7', borderColor: '#6C5CE7' },
  filterText: { color: '#888', fontSize: 13 },
  filterTextActive: { color: '#fff' },
  taskItem: {
    flexDirection: 'row', alignItems: 'center', padding: 16,
    borderBottomWidth: 1, borderBottomColor: '#1e2a4a', gap: 12,
  },
  checkbox: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
    borderColor: '#6C5CE7', alignItems: 'center', justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: '#27AE60', borderColor: '#27AE60' },
  taskContent: { flex: 1 },
  taskTitle: { fontSize: 16, color: '#fff' },
  taskTitleDone: { color: '#666', textDecorationLine: 'line-through' },
  taskMeta: { flexDirection: 'row', gap: 12, marginTop: 4 },
  taskAssignee: { fontSize: 12, color: '#6C5CE7' },
  taskDue: { fontSize: 12, color: '#F39C12' },
  taskCoins: { fontSize: 12, color: '#F1C40F' },
  taskRight: { alignItems: 'center', gap: 4 },
  subtaskCount: { fontSize: 11, color: '#888' },
  empty: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { color: '#666', fontSize: 16 },
});
