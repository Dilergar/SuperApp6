import { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/lib/api';

export default function CalendarScreen() {
  const [currentDate, setCurrentDate] = useState(new Date());

  const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);

  const { data } = useQuery({
    queryKey: ['calendar', currentDate.getFullYear(), currentDate.getMonth()],
    queryFn: async () => {
      const res = await api.get('/calendar/events', {
        params: {
          from: startOfMonth.toISOString(),
          to: endOfMonth.toISOString(),
        },
      });
      return res.data.data as any[];
    },
  });

  const events = data || [];

  const prevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  // Generate calendar days
  const daysInMonth = endOfMonth.getDate();
  const firstDayOfWeek = (startOfMonth.getDay() + 6) % 7; // Monday = 0
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const getEventsForDay = (day: number) => {
    return events.filter((e: any) => {
      const eDate = new Date(e.startTime);
      return eDate.getDate() === day &&
        eDate.getMonth() === currentDate.getMonth() &&
        eDate.getFullYear() === currentDate.getFullYear();
    });
  };

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() &&
    currentDate.getMonth() === today.getMonth() &&
    currentDate.getFullYear() === today.getFullYear();

  const monthName = currentDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  return (
    <ScrollView style={styles.container}>
      {/* Month navigation */}
      <View style={styles.monthNav}>
        <TouchableOpacity onPress={prevMonth}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.monthTitle}>{monthName}</Text>
        <TouchableOpacity onPress={nextMonth}>
          <Ionicons name="chevron-forward" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Week day headers */}
      <View style={styles.weekRow}>
        {weekDays.map((d) => (
          <Text key={d} style={styles.weekDay}>{d}</Text>
        ))}
      </View>

      {/* Calendar grid */}
      <View style={styles.grid}>
        {days.map((day, i) => {
          const dayEvents = day ? getEventsForDay(day) : [];
          return (
            <View key={i} style={styles.dayCell}>
              {day && (
                <>
                  <Text style={[styles.dayNumber, isToday(day) && styles.todayNumber]}>
                    {day}
                  </Text>
                  {dayEvents.length > 0 && (
                    <View style={styles.eventDots}>
                      {dayEvents.slice(0, 3).map((e: any, idx: number) => (
                        <View
                          key={idx}
                          style={[styles.dot, { backgroundColor: e.color || '#6C5CE7' }]}
                        />
                      ))}
                    </View>
                  )}
                </>
              )}
            </View>
          );
        })}
      </View>

      {/* Today's events list */}
      <Text style={styles.sectionTitle}>
        События на {today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}
      </Text>
      {events
        .filter((e: any) => {
          const d = new Date(e.startTime);
          return d.toDateString() === today.toDateString();
        })
        .map((e: any) => (
          <View key={e.id} style={styles.eventItem}>
            <View style={[styles.eventColor, { backgroundColor: e.color || '#6C5CE7' }]} />
            <View style={styles.eventContent}>
              <Text style={styles.eventTitle}>{e.title}</Text>
              <Text style={styles.eventTime}>
                {e.allDay
                  ? 'Весь день'
                  : `${new Date(e.startTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} — ${new Date(e.endTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
              </Text>
            </View>
            {e.type === 'task' && (
              <Ionicons name="checkbox-outline" size={16} color="#888" />
            )}
          </View>
        ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e', padding: 16 },
  monthNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  monthTitle: { fontSize: 20, fontWeight: '600', color: '#fff', textTransform: 'capitalize' },
  weekRow: { flexDirection: 'row', marginBottom: 8 },
  weekDay: { flex: 1, textAlign: 'center', color: '#888', fontSize: 13, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center',
    justifyContent: 'center', padding: 2,
  },
  dayNumber: { fontSize: 16, color: '#ccc' },
  todayNumber: {
    color: '#fff', fontWeight: 'bold', backgroundColor: '#6C5CE7',
    borderRadius: 14, width: 28, height: 28, textAlign: 'center',
    lineHeight: 28, overflow: 'hidden',
  },
  eventDots: { flexDirection: 'row', gap: 2, marginTop: 2 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#fff', marginTop: 24, marginBottom: 12 },
  eventItem: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#16213e',
    borderRadius: 12, padding: 14, marginBottom: 8, gap: 12,
  },
  eventColor: { width: 4, height: 36, borderRadius: 2 },
  eventContent: { flex: 1 },
  eventTitle: { fontSize: 15, color: '#fff' },
  eventTime: { fontSize: 13, color: '#888', marginTop: 2 },
});
