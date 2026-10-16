import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Svg, { Path, Circle, Text as SvgText, Line } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../utils/theme';
import { getActivities, formatDistance, formatDuration } from '../utils/storage';
import { ActivityTypeIcon, ChevronRightIcon, TrackIcon } from '../components/Icons';
import { ACTIVITY_TYPES, getActivityLabel, getActivityRouteColor, usesPace } from '../utils/activityTypes';
import { mergeProgressSettings } from '../utils/progressSettings';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const GRAPH_WIDTH = SCREEN_WIDTH - 48;
const PROGRESS_SETTINGS_KEY = '@trail_tracker_progress_settings';

// Icons
const ChevronUpIcon = ({ size = 20, color = '#424242' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M18 15l-6-6-6 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ChevronDownIcon = ({ size = 20, color = '#424242' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M6 9l6 6 6-6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export default function StatsScreen() {
  const { theme, distanceUnit } = useTheme();
  const navigation = useNavigation();
  const [activities, setActivities] = useState([]);
  const [timeWindow, setTimeWindow] = useState('week');
  const [progressType, setProgressType] = useState(null);
  const [progressActivePage, setProgressActivePage] = useState(0);
  const progressPagerRef = useRef(null);
  
  const [progressSettings, setProgressSettings] = useState(() => mergeProgressSettings());

  useEffect(() => {
    loadProgressSettings();
  }, []);

  const loadProgressSettings = async () => {
    try {
      const saved = await AsyncStorage.getItem(PROGRESS_SETTINGS_KEY);
      if (saved) {
        setProgressSettings(mergeProgressSettings(JSON.parse(saved)));
      }
    } catch (e) {
      console.log('Error loading progress settings:', e);
    }
  };

  const saveProgressSettings = async (newSettings) => {
    try {
      await AsyncStorage.setItem(PROGRESS_SETTINGS_KEY, JSON.stringify(newSettings));
    } catch (e) {
      console.log('Error saving progress settings:', e);
    }
  };

  const adjustCount = (activityType, graphType, delta) => {
    const newValue = Math.max(1, Math.min(20, progressSettings[activityType][graphType] + delta));
    const newSettings = {
      ...progressSettings,
      [activityType]: { ...progressSettings[activityType], [graphType]: newValue },
    };
    setProgressSettings(newSettings);
    saveProgressSettings(newSettings);
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    const activitiesData = await getActivities();
    setActivities(activitiesData);
  };

  const getFilteredActivities = () => {
    const now = new Date();
    return activities.filter(activity => {
      const activityDate = new Date(activity.timestamp);
      switch (timeWindow) {
        case 'week': {
          const day = now.getDay();
          const diff = day === 0 ? 6 : day - 1;
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - diff);
          weekStart.setHours(0, 0, 0, 0);
          return activityDate >= weekStart;
        }
        case 'month': {
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
          return activityDate >= monthStart;
        }
        case 'year': {
          const yearStart = new Date(now.getFullYear(), 0, 1);
          return activityDate >= yearStart;
        }
        default:
          return true;
      }
    });
  };

  const getDailyTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const dayActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= date && activityDate < nextDate;
      });
      totals.push({
        label: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        value: dayActivities.reduce((sum, a) => sum + (a.distance || 0), 0),
      });
    }
    return totals;
  };

  const getWeeklyTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    
    const getCurrentMonday = (date) => {
      const d = new Date(date);
      const day = d.getDay();
      const diff = (day === 0 ? 6 : day - 1);
      d.setDate(d.getDate() - diff);
      d.setHours(0, 0, 0, 0);
      return d;
    };
    
    for (let i = count - 1; i >= 0; i--) {
      const weekStart = getCurrentMonday(now);
      weekStart.setDate(weekStart.getDate() - (i * 7));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      
      const weekActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= weekStart && activityDate < weekEnd;
      });
      
      const d = new Date(Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      
      totals.push({
        label: `W${weekNum}`,
        value: weekActivities.reduce((sum, a) => sum + (a.distance || 0), 0),
      });
    }
    return totals;
  };

  const getMonthlyTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= monthStart && activityDate < monthEnd;
      });
      totals.push({
        label: monthStart.toLocaleDateString('en-GB', { month: 'short' }),
        value: monthActivities.reduce((sum, a) => sum + (a.distance || 0), 0),
      });
    }
    return totals;
  };

  // Returns pace for walking/running and speed for biking.
  const calcAvgMetric = (activityList, type, unit) => {
    const valid = activityList.filter(a => a.distance > 0 && a.duration > 0);
    if (valid.length === 0) return null;
    const totalDistUnit = valid.reduce((sum, a) => {
      return sum + (unit === 'miles' ? a.distance * 0.621371 : a.distance);
    }, 0);
    const totalMinutes = valid.reduce((sum, a) => sum + a.duration / 60, 0);
    if (totalDistUnit === 0) return null;
    return usesPace(type) ? totalMinutes / totalDistUnit : totalDistUnit / (totalMinutes / 60);
  };

  const formatPaceValue = (minPerUnit) => {
    if (minPerUnit === null || minPerUnit === undefined) return null;
    return parseFloat(minPerUnit.toFixed(1));
  };

  const getDailyPaceTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const dayActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= date && activityDate < nextDate;
      });
      const pace = calcAvgMetric(dayActivities, type, distanceUnit);
      totals.push({
        label: date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
        value: pace !== null ? formatPaceValue(pace) : 0,
        hasData: pace !== null,
      });
    }
    return totals;
  };

  const getWeeklyPaceTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    const getCurrentMonday = (date) => {
      const d = new Date(date);
      const day = d.getDay();
      const diff = (day === 0 ? 6 : day - 1);
      d.setDate(d.getDate() - diff);
      d.setHours(0, 0, 0, 0);
      return d;
    };
    for (let i = count - 1; i >= 0; i--) {
      const weekStart = getCurrentMonday(now);
      weekStart.setDate(weekStart.getDate() - (i * 7));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= weekStart && activityDate < weekEnd;
      });
      const d = new Date(Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()));
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
      const pace = calcAvgMetric(weekActivities, type, distanceUnit);
      totals.push({
        label: `W${weekNum}`,
        value: pace !== null ? formatPaceValue(pace) : 0,
        hasData: pace !== null,
      });
    }
    return totals;
  };

  const getMonthlyPaceTotals = (type, count) => {
    const totals = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const monthActivities = activities.filter(a => {
        const activityDate = new Date(a.timestamp);
        return a.type === type && activityDate >= monthStart && activityDate < monthEnd;
      });
      const pace = calcAvgMetric(monthActivities, type, distanceUnit);
      totals.push({
        label: monthStart.toLocaleDateString('en-GB', { month: 'short' }),
        value: pace !== null ? formatPaceValue(pace) : 0,
        hasData: pace !== null,
      });
    }
    return totals;
  };

  // Progress graph - generic for both distance and pace
  const renderProgressGraph = (data, title, activityType, graphType, count, metricMode = null) => {
    const isMetric = metricMode !== null;
    const isPace = metricMode === 'pace';
    const padding = { left: 10, right: 10, top: 28, bottom: 22 };
    const graphW = GRAPH_WIDTH - padding.left - padding.right;
    const availableH = SCREEN_HEIGHT - 24 - 50 - 38 - 80 - 8;
    const cardH = Math.floor(availableH / 3) - 8;
    const graphH = Math.max(cardH - padding.top - padding.bottom - 40, 40);

    const validValues = data.filter(d => d.hasData !== false && d.value > 0).map(d => d.value);
    const maxValue = validValues.length > 0 ? Math.max(...validValues) : 1;
    const minValue = isPace && validValues.length > 0 ? Math.min(...validValues) : 0;
    const valueRange = isPace ? Math.max(maxValue - minValue, 0.5) : maxValue;

    const formatValue = (val) => {
      if (isPace) return val > 0 ? `${val}'` : '';
      if (metricMode === 'speed') return val > 0 ? val.toFixed(1) : '';
      return distanceUnit === 'miles' ? (val * 0.621371).toFixed(1) : val.toFixed(1);
    };

    const getY = (val, hasData) => {
      if (!hasData || val === 0) return padding.top + graphH;
      if (isPace) {
        const paddedMin = minValue - valueRange * 0.1;
        const paddedMax = maxValue + valueRange * 0.1;
        const paddedRange = paddedMax - paddedMin;
        return padding.top + graphH - ((val - paddedMin) / paddedRange) * graphH;
      }
      return padding.top + graphH - (val / maxValue) * graphH;
    };

    const points = data.map((d, i) => {
      const hasData = d.hasData !== undefined ? d.hasData : d.value > 0;
      return {
        x: padding.left + (i / Math.max(data.length - 1, 1)) * graphW,
        y: getY(d.value, hasData),
        value: d.value, label: d.label,
        hasData,
      };
    });

    const linePath = points.length > 1 ? points.map((p, i) => {
      const y = p.hasData ? p.y : padding.top + graphH;
      return `${i === 0 ? 'M' : 'L'} ${p.x} ${y}`;
    }).join(' ') : '';

    let summaryLabel = '';
    let summaryValue = '';
    if (isMetric) {
      const validPoints = data.filter(d => d.hasData && d.value > 0);
      if (validPoints.length > 0) {
        const avg = validPoints.reduce((s, d) => s + d.value, 0) / validPoints.length;
        summaryLabel = 'Avg:';
        summaryValue = isPace
          ? `${avg.toFixed(1)}'/${distanceUnit === 'miles' ? 'mi' : 'km'}`
          : `${avg.toFixed(1)} ${distanceUnit === 'miles' ? 'mph' : 'km/h'}`;
      }
    } else {
      const periodTotal = data.reduce((sum, d) => sum + d.value, 0);
      summaryLabel = 'Total:';
      summaryValue = formatDistance(periodTotal, distanceUnit);
    }

    return (
      <View style={[styles.graphCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.graphHeader}>
          <View style={styles.countControl}>
            <TouchableOpacity style={[styles.countButton, { backgroundColor: theme.surface }]} onPress={() => adjustCount(activityType, graphType, 1)} disabled={count >= 20}>
              <ChevronUpIcon size={18} color={count >= 20 ? theme.border : theme.icon} />
            </TouchableOpacity>
            <Text style={[styles.countText, { color: theme.text }]}>{count}</Text>
            <TouchableOpacity style={[styles.countButton, { backgroundColor: theme.surface }]} onPress={() => adjustCount(activityType, graphType, -1)} disabled={count <= 1}>
              <ChevronDownIcon size={18} color={count <= 1 ? theme.border : theme.icon} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.graphTitle, { color: theme.text }]}>{title}</Text>
          <View style={styles.graphTotalContainer}>
            {summaryLabel ? (
              <>
                <Text style={[styles.graphTotalLabel, { color: theme.textSecondary }]}>{summaryLabel}</Text>
                <Text style={[styles.graphTotalValue, { color: theme.primary }]}>{summaryValue}</Text>
              </>
            ) : null}
          </View>
        </View>
        <Svg width={GRAPH_WIDTH} height={cardH - 40}>
          <Line x1={padding.left} y1={padding.top + graphH} x2={GRAPH_WIDTH - padding.right} y2={padding.top + graphH} stroke={theme.border} strokeWidth={1} />
          {linePath && <Path d={linePath} stroke={theme.primary} strokeWidth={2} fill="none" />}
          {points.map((point, i) => (
            <React.Fragment key={i}>
              {point.hasData && (
                <SvgText x={point.x} y={point.y - 8} fontSize={10} fill={theme.text} textAnchor="middle">{formatValue(point.value)}</SvgText>
              )}
              <Circle cx={point.x} cy={point.hasData ? point.y : padding.top + graphH} r={6} fill={point.hasData ? theme.primary : theme.border} />
              {i % Math.max(1, Math.floor(points.length / 6)) === 0 && <SvgText x={point.x} y={cardH - 40 - 3} fontSize={9} fill={theme.textSecondary} textAnchor="middle">{point.label}</SvgText>}
            </React.Fragment>
          ))}
        </Svg>
      </View>
    );
  };

  // Progress view with horizontal swipe: Distance (left) | Pace (right)
  const renderProgressView = () => {
    const settings = progressSettings[progressType];
    const handleScroll = (event) => {
      const page = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
      if (page !== progressActivePage) {
        setProgressActivePage(page);
      }
    };

    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.progressHeader}>
          <TouchableOpacity style={[styles.backButton, { backgroundColor: theme.surface }]} onPress={() => { setProgressType(null); setProgressActivePage(0); }}>
            <Text style={[styles.backButtonText, { color: theme.primary }]}>Back</Text>
          </TouchableOpacity>
          <View style={styles.progressTitleContainer}>
            <ActivityTypeIcon type={progressType} size={24} color={getActivityRouteColor(progressType)} />
            <Text style={[styles.progressTitle, { color: theme.text }]}>{getActivityLabel(progressType)} Progress</Text>
          </View>
          <View style={styles.backButton} />
        </View>

        {/* Page indicator tabs */}
        <View style={styles.pageTabRow}>
          <TouchableOpacity
            style={[styles.pageTab, progressActivePage === 0 && { borderBottomColor: theme.primary, borderBottomWidth: 2 }]}
            onPress={() => progressPagerRef.current?.scrollTo({ x: 0, animated: true })}
          >
            <Text style={[styles.pageTabText, { color: progressActivePage === 0 ? theme.primary : theme.textSecondary }]}>Distance</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.pageTab, progressActivePage === 1 && { borderBottomColor: theme.primary, borderBottomWidth: 2 }]}
            onPress={() => progressPagerRef.current?.scrollTo({ x: SCREEN_WIDTH, animated: true })}
          >
            <Text style={[styles.pageTabText, { color: progressActivePage === 1 ? theme.primary : theme.textSecondary }]}>{usesPace(progressType) ? 'Pace' : 'Speed'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={progressPagerRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={handleScroll}
          style={{ flex: 1 }}
          scrollEventThrottle={16}
        >
          {/* Page 1: Distance */}
          <View style={[styles.progressPage, { width: SCREEN_WIDTH }]}>
            {renderProgressGraph(getDailyTotals(progressType, settings.daily), 'Daily Distance', progressType, 'daily', settings.daily)}
            {renderProgressGraph(getWeeklyTotals(progressType, settings.weekly), 'Weekly Distance', progressType, 'weekly', settings.weekly)}
            {renderProgressGraph(getMonthlyTotals(progressType, settings.monthly), 'Monthly Distance', progressType, 'monthly', settings.monthly)}
          </View>

          {/* Page 2: Pace */}
          <View style={[styles.progressPage, { width: SCREEN_WIDTH }]}>
            {renderProgressGraph(getDailyPaceTotals(progressType, settings.daily), `Daily ${usesPace(progressType) ? 'Pace' : 'Speed'}`, progressType, 'daily', settings.daily, usesPace(progressType) ? 'pace' : 'speed')}
            {renderProgressGraph(getWeeklyPaceTotals(progressType, settings.weekly), `Weekly ${usesPace(progressType) ? 'Pace' : 'Speed'}`, progressType, 'weekly', settings.weekly, usesPace(progressType) ? 'pace' : 'speed')}
            {renderProgressGraph(getMonthlyPaceTotals(progressType, settings.monthly), `Monthly ${usesPace(progressType) ? 'Pace' : 'Speed'}`, progressType, 'monthly', settings.monthly, usesPace(progressType) ? 'pace' : 'speed')}
          </View>
        </ScrollView>
      </View>
    );
  };

  // Main render
  if (progressType) return renderProgressView();

  const filtered = getFilteredActivities();
  const totalDistance = filtered.reduce((sum, a) => sum + (a.distance || 0), 0);
  const totalDuration = filtered.reduce((sum, a) => sum + (a.duration || 0), 0);

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.progressButtonContainer}>
        <View style={styles.progressButtonRow}>
          {ACTIVITY_TYPES.map(type => (
            <TouchableOpacity key={type.id} style={[styles.progressButton, styles.progressButtonThird, { backgroundColor: type.routeColor }]} onPress={() => setProgressType(type.id)}>
              <ActivityTypeIcon type={type.id} size={19} color="#fff" />
              <Text style={styles.progressButtonText}>{type.shortLabel}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.timeWindowContainer}>
        {['week', 'month', 'year', 'all'].map(window => (
          <TouchableOpacity key={window} style={[styles.timeWindowButton, { backgroundColor: timeWindow === window ? theme.primary : theme.surface, borderColor: timeWindow === window ? theme.primary : theme.border }]} onPress={() => setTimeWindow(window)}>
            <Text style={[styles.timeWindowText, { color: timeWindow === window ? '#fff' : theme.text }]}>{window === 'all' ? 'All Time' : window.charAt(0).toUpperCase() + window.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {activities.length === 0 ? (
        <View style={styles.emptyState}>
          <TrackIcon size={48} color={theme.border} />
          <Text style={[styles.emptyStateText, { color: theme.textSecondary }]}>No activities yet. Start tracking to see your stats!</Text>
        </View>
      ) : (
        <>
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>SUMMARY</Text>
            <View style={[styles.card, { backgroundColor: theme.cardBg }]}>
              <View style={styles.mainStat}>
                <Text style={[styles.mainStatValue, { color: theme.primary }]}>{formatDistance(totalDistance, distanceUnit)}</Text>
                <Text style={[styles.mainStatLabel, { color: theme.textSecondary }]}>Total Distance</Text>
              </View>
              <View style={styles.statsRow}>
                <View style={styles.statItem}><Text style={[styles.statValue, { color: theme.text }]}>{filtered.length}</Text><Text style={[styles.statLabel, { color: theme.textSecondary }]}>Activities</Text></View>
                <View style={styles.statItem}><Text style={[styles.statValue, { color: theme.text }]}>{formatDuration(totalDuration)}</Text><Text style={[styles.statLabel, { color: theme.textSecondary }]}>Time</Text></View>
              </View>
              <View style={[styles.statsRow, { marginTop: 14 }]}>
                <View style={styles.statItem}><Text style={[styles.statValue, { color: theme.text }]}>{filtered.filter(a => a.type === 'walking').length}</Text><Text style={[styles.statLabel, { color: theme.textSecondary }]}>Walks</Text></View>
                <View style={styles.statItem}><Text style={[styles.statValue, { color: theme.text }]}>{filtered.filter(a => a.type === 'running').length}</Text><Text style={[styles.statLabel, { color: theme.textSecondary }]}>Runs</Text></View>
                <View style={styles.statItem}><Text style={[styles.statValue, { color: theme.text }]}>{filtered.filter(a => a.type === 'biking').length}</Text><Text style={[styles.statLabel, { color: theme.textSecondary }]}>Rides</Text></View>
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>RECENT ACTIVITIES</Text>
            {[...filtered].sort((a, b) => {
              const getDate = (act) => new Date(act.date || act.timestamp || act.startTime || act.startDate || 0).getTime();
              return getDate(b) - getDate(a);
            }).slice(0, 5).map(activity => (
              <TouchableOpacity key={activity.id} style={[styles.recentActivity, { backgroundColor: theme.cardBg }]} onPress={() => navigation.navigate('ActivityDetail', { activityId: activity.id })}>
                <View style={styles.recentActivityLeft}>
                  <View style={[styles.recentIcon, { backgroundColor: theme.primaryLight }]}>
                    <ActivityTypeIcon type={activity.type} size={20} color={getActivityRouteColor(activity.type)} />
                  </View>
                  <View style={styles.recentInfo}>
                    <Text style={[styles.recentType, { color: theme.text }]}>{getActivityLabel(activity.type)}</Text>
                    <Text style={[styles.recentDate, { color: theme.textSecondary }]}>{new Date(activity.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Text>
                  </View>
                </View>
                <View style={styles.recentStats}>
                  <Text style={[styles.recentStat, { color: theme.text }]}>{formatDistance(activity.distance, distanceUnit)}</Text>
                  <ChevronRightIcon size={18} color={theme.textSecondary} />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  timeWindowContainer: { flexDirection: 'row', padding: 16, paddingTop: 8, gap: 8 },
  timeWindowButton: { flex: 1, paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
  timeWindowText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  progressButtonContainer: { paddingHorizontal: 16, marginBottom: 16, paddingTop: 16 },
  progressButtonRow: { flexDirection: 'row', gap: 12 },
  progressButton: { paddingVertical: 14, borderRadius: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 },
  progressButtonThird: { flex: 1 },
  progressButtonText: { color: '#fff', fontSize: 12, fontFamily: 'Inter_700Bold' },
  section: { paddingHorizontal: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 11, fontFamily: 'Inter_700Bold', letterSpacing: 0.5, marginBottom: 8 },
  card: { borderRadius: 12, padding: 16 },
  mainStat: { alignItems: 'center', marginBottom: 16, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2A2A2A' },
  mainStatValue: { fontSize: 32, fontFamily: 'Inter_700Bold' },
  mainStatLabel: { fontSize: 11, fontFamily: 'Inter_400Regular', textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  statLabel: { fontSize: 10, fontFamily: 'Inter_400Regular', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 },
  recentActivity: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderRadius: 10, marginBottom: 8 },
  recentActivityLeft: { flexDirection: 'row', alignItems: 'center' },
  recentIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  recentInfo: { marginLeft: 10 },
  recentType: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  recentDate: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  recentStats: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  recentStat: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  emptyState: { alignItems: 'center', justifyContent: 'center', padding: 48 },
  emptyStateText: { fontSize: 15, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 16 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 10, paddingHorizontal: 16 },
  pageTabRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2A2A2A' },
  pageTab: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  pageTabText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  progressTitleContainer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  backButton: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, minWidth: 80 },
  backButtonText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  progressScroll: { flex: 1 },
  progressContent: { padding: 16, paddingTop: 0 },
  progressPage: { flex: 1, paddingHorizontal: 8, paddingTop: 4, gap: 4 },
  graphCard: { borderRadius: 12, padding: 8, marginBottom: 0 },
  graphHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  graphTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', flex: 1, textAlign: 'center' },
  countControl: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  countButton: { width: 28, height: 28, borderRadius: 6, justifyContent: 'center', alignItems: 'center' },
  countText: { fontSize: 14, fontFamily: 'Inter_700Bold', minWidth: 24, textAlign: 'center' },
  countControlSpacer: { width: 60 },
  graphTotalContainer: { alignItems: 'flex-end', minWidth: 70 },
  graphTotalLabel: { fontSize: 10, fontFamily: 'Inter_400Regular' },
  graphTotalValue: { fontSize: 14, fontFamily: 'Inter_700Bold' },
});
