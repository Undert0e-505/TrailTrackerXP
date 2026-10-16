import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  Dimensions,
} from 'react-native';
import { Calendar } from 'react-native-calendars';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Svg, { Path, Polyline, Circle as SvgCircle, Rect } from 'react-native-svg';
import { useTheme } from '../utils/theme';
import { getActivities, deleteActivity, formatDistance, formatDuration } from '../utils/storage';
import { loadRouteFromFile } from '../utils/fileStorage';
import { ActivityTypeIcon, ChevronRightIcon, TrackIcon } from '../components/Icons';
import { getActivityLabel, getActivityRouteColor } from '../utils/activityTypes';

// Trash icon for delete modal
const TrashIcon = ({ size = 24, color = '#D32F2F' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M10 11v6M14 11v6" stroke={color} strokeWidth="2" strokeLinecap="round" />
  </Svg>
);

// Activity thumbnail with map overlay
const ActivityThumbnail = ({ route, type, theme, size = 80 }) => {
  if (!route || route.length < 2) {
    return (
      <View style={[thumbnailStyles.container, { width: size, height: size, backgroundColor: theme.surface }]}>
        <TrackIcon size={size * 0.4} color={theme.border} />
      </View>
    );
  }

  // Calculate bounding box of the route
  const lats = route.map(p => p.latitude);
  const lngs = route.map(p => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  
  // Add padding
  const padding = 8;
  const drawWidth = size - padding * 2;
  const drawHeight = size - padding * 2;
  
  // Calculate scale to fit route in thumbnail
  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;
  
  // Account for aspect ratio (latitude distance varies by longitude)
  const avgLat = (minLat + maxLat) / 2;
  const lngCorrectionFactor = Math.cos(avgLat * Math.PI / 180);
  const correctedLngRange = lngRange * lngCorrectionFactor;
  
  const scale = Math.min(drawWidth / correctedLngRange, drawHeight / latRange);
  
  // Center the route in the thumbnail
  const routeWidth = correctedLngRange * scale;
  const routeHeight = latRange * scale;
  const offsetX = padding + (drawWidth - routeWidth) / 2;
  const offsetY = padding + (drawHeight - routeHeight) / 2;
  
  // Convert coordinates to SVG path
  const points = route.map(p => {
    const x = offsetX + (p.longitude - minLng) * lngCorrectionFactor * scale;
    const y = offsetY + (maxLat - p.latitude) * scale; // Invert Y axis
    return `${x},${y}`;
  }).join(' ');
  
  const routeColor = getActivityRouteColor(type);
  
  // Get start and end points
  const startX = offsetX + (route[0].longitude - minLng) * lngCorrectionFactor * scale;
  const startY = offsetY + (maxLat - route[0].latitude) * scale;
  const endX = offsetX + (route[route.length - 1].longitude - minLng) * lngCorrectionFactor * scale;
  const endY = offsetY + (maxLat - route[route.length - 1].latitude) * scale;

  return (
    <View style={[thumbnailStyles.container, { width: size, height: size, backgroundColor: theme.surface }]}>
      <Svg width={size} height={size}>
        {/* Background rectangle */}
        <Rect x="0" y="0" width={size} height={size} fill={theme.surface} rx="8" />
        
        {/* Route polyline */}
        <Polyline
          points={points}
          fill="none"
          stroke={routeColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        
        {/* Start marker (green) */}
        <SvgCircle cx={startX} cy={startY} r="4" fill="#4CAF50" stroke="#fff" strokeWidth="1.5" />
        
        {/* End marker (red) */}
        <SvgCircle cx={endX} cy={endY} r="4" fill="#F44336" stroke="#fff" strokeWidth="1.5" />
      </Svg>
    </View>
  );
};

const thumbnailStyles = StyleSheet.create({
  container: {
    borderRadius: 8,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default function CalendarScreen() {
  const { theme, isDark, distanceUnit } = useTheme();
  const navigation = useNavigation();
  const [activities, setActivities] = useState([]);
  // Initialize with today's date
  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [markedDates, setMarkedDates] = useState({});
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [activityToDelete, setActivityToDelete] = useState(null);
  // Route cache: activityId -> route array (loaded on-demand)
  const routeCache = useRef({});

  useFocusEffect(
    useCallback(() => {
      loadActivities();
    }, [])
  );

  const loadActivities = async () => {
    // Load activity metadata only (fast - no GPX file reads)
    // getActivities() now dedupes by id and validates against GPX files
    const data = await getActivities();
    
    // Safety net: dedupe by id in case getActivities returns duplicates
    const seen = new Set();
    const deduped = data.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    setActivities(deduped);
    
    const marks = {};
    data.forEach(activity => {
      const date = activity.timestamp.split('T')[0];
      if (!marks[date]) {
        marks[date] = { marked: true, dots: [] };
      }
      marks[date].dots.push({
        key: activity.id,
        color: getActivityRouteColor(activity.type),
      });
    });
    
    setMarkedDates(marks);
    
    // Pre-load routes for today's activities (most likely to be viewed first)
    const todayActivities = data.filter(a => a.timestamp.startsWith(today));
    for (const activity of todayActivities) {
      if (!routeCache.current[activity.id]) {
        const existingRoute = activity.route || activity.routeData;
        if (existingRoute && existingRoute.length > 0) {
          routeCache.current[activity.id] = existingRoute;
        } else {
          const route = await loadRouteFromFile(activity.id);
          if (route) routeCache.current[activity.id] = route;
        }
      }
    }
    if (todayActivities.length > 0) {
      setActivities(prev => [...prev]);
    }
  };

  const onDayPress = async (day) => {
    setSelectedDate(day.dateString);
    // Lazy-load routes for activities on the selected day
    const dayActivities = activities.filter(a => a.timestamp.startsWith(day.dateString));
    for (const activity of dayActivities) {
      if (!routeCache.current[activity.id]) {
        const existingRoute = activity.route || activity.routeData;
        if (existingRoute && existingRoute.length > 0) {
          routeCache.current[activity.id] = existingRoute;
        } else {
          // Load from GPX file on-demand
          const route = await loadRouteFromFile(activity.id);
          if (route) {
            routeCache.current[activity.id] = route;
          }
        }
      }
    }
    // Trigger re-render with updated cache
    setActivities(prev => [...prev]);
  };

  const getActivitiesForDate = (date) => {
    if (!date) return [];
    return activities.filter(activity => 
      activity.timestamp.startsWith(date)
    );
  };

  const handleDeleteActivity = (id) => {
    setActivityToDelete(id);
    setShowDeleteModal(true);
  };

  const confirmDelete = async () => {
    if (activityToDelete) {
      await deleteActivity(activityToDelete);
      loadActivities();
    }
    setShowDeleteModal(false);
    setActivityToDelete(null);
  };

  const handleActivityPress = (activityId) => {
    navigation.navigate('ActivityDetail', { activityId });
  };

  const selectedActivities = getActivitiesForDate(selectedDate);

  // Base font sizes increased by 20%
  const calendarTheme = {
    backgroundColor: theme.background,
    calendarBackground: theme.cardBg,
    textSectionTitleColor: theme.textSecondary,
    selectedDayBackgroundColor: theme.primary,
    selectedDayTextColor: '#ffffff',
    todayTextColor: theme.primary,
    dayTextColor: theme.text,
    textDisabledColor: theme.border,
    dotColor: theme.primary,
    monthTextColor: theme.text,
    arrowColor: theme.primary,
    textDayFontFamily: 'Inter_400Regular',
    textMonthFontFamily: 'Inter_600SemiBold',
    textDayHeaderFontFamily: 'Inter_500Medium',
    // Font sizes increased by 20%
    textDayFontSize: 18,        // default ~15, now 18
    textMonthFontSize: 19,      // default ~16, now 19
    textDayHeaderFontSize: 16,  // default ~13, now 16
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Calendar
        firstDay={1}
        onDayPress={onDayPress}
        markedDates={{
          ...markedDates,
          [selectedDate]: {
            ...markedDates[selectedDate],
            selected: true,
            selectedColor: theme.primary,
          },
        }}
        markingType={'multi-dot'}
        theme={calendarTheme}
        style={[styles.calendar, { backgroundColor: theme.cardBg }]}
      />

      <ScrollView style={styles.activitiesList}>
        {selectedDate ? (
          selectedActivities.length > 0 ? (
            selectedActivities.map((activity) => (
              <TouchableOpacity 
                key={activity.id} 
                style={[styles.activityCard, { backgroundColor: theme.cardBg }]}
                onPress={() => handleActivityPress(activity.id)}
                activeOpacity={0.7}
              >
                <View style={styles.activityMainRow}>
                  {/* Map Thumbnail */}
                  <ActivityThumbnail 
                    route={routeCache.current[activity.id] || activity.route || activity.routeData} 
                    type={activity.type} 
                    theme={theme} 
                    size={80} 
                  />
                  
                  {/* Activity Details */}
                  <View style={styles.activityDetails}>
                    <View style={styles.activityHeader}>
                      <View style={styles.activityTitleRow}>
                        <View style={[styles.iconContainer, { backgroundColor: theme.primaryLight }]}>
                          <ActivityTypeIcon type={activity.type} size={20} color={getActivityRouteColor(activity.type)} />
                        </View>
                        <View style={styles.activityInfo}>
                          <Text style={[styles.activityTitle, { color: theme.text }]}>
                            {getActivityLabel(activity.type)}
                          </Text>
                          <Text style={[styles.activityTime, { color: theme.textSecondary }]}>
                            {new Date(activity.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.activityActions}>
                        <TouchableOpacity
                          onPress={() => handleDeleteActivity(activity.id)}
                          style={styles.deleteButton}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        >
                          <TrashIcon size={18} color={theme.danger} />
                        </TouchableOpacity>
                        <ChevronRightIcon size={18} color={theme.textSecondary} />
                      </View>
                    </View>

                    <View style={styles.activityStats}>
                      <View style={[styles.stat, { backgroundColor: theme.surface }]}>
                        <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Distance</Text>
                        <Text style={[styles.statValue, { color: theme.primary }]}>
                          {formatDistance(activity.distance, distanceUnit)}
                        </Text>
                      </View>
                      <View style={[styles.stat, { backgroundColor: theme.surface }]}>
                        <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Duration</Text>
                        <Text style={[styles.statValue, { color: theme.primary }]}>
                          {formatDuration(activity.duration)}
                        </Text>
                      </View>
                      {activity.elevationGain > 0 && (
                        <View style={[styles.stat, { backgroundColor: theme.surface }]}>
                          <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Elev</Text>
                          <Text style={[styles.statValue, { color: theme.primary }]}>
                            +{Math.round(activity.elevationGain)} m
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>
                No activities on this date
              </Text>
            </View>
          )
        ) : (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>
              Select a date to view activities
            </Text>
          </View>
        )}

        {activities.length === 0 && !selectedDate && (
          <View style={styles.emptyState}>
            <TrackIcon size={48} color={theme.border} />
            <Text style={[styles.emptyStateText, { color: theme.textSecondary, marginTop: 12 }]}>
              No activities yet. Start tracking to see them here!
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg }]}>
            <TrashIcon size={56} color={theme.danger} />
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Delete Activity?
            </Text>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}>
              This cannot be undone.
            </Text>
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: theme.danger }]}
              onPress={confirmDelete}
            >
              <Text style={styles.modalButtonText}>Delete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalCancelButton, { backgroundColor: theme.surface }]}
              onPress={() => setShowDeleteModal(false)}
            >
              <Text style={[styles.modalCancelButtonText, { color: theme.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  calendar: {
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  activitiesList: {
    flex: 1,
    padding: 16,
  },
  activityCard: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  activityMainRow: {
    flexDirection: 'row',
    gap: 12,
  },
  activityDetails: {
    flex: 1,
  },
  activityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  activityTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activityInfo: {
    marginLeft: 10,
  },
  activityTitle: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  activityTime: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  activityActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  deleteButton: {
    padding: 4,
  },
  activityStats: {
    flexDirection: 'row',
    gap: 6,
  },
  stat: {
    flex: 1,
    padding: 6,
    borderRadius: 6,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 1,
  },
  statValue: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyStateText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxWidth: 300,
    borderRadius: 24,
    padding: 32,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  modalTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginTop: 20,
    marginBottom: 8,
    textAlign: 'center',
  },
  modalMessage: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  modalButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  modalCancelButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  modalCancelButtonText: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
});
