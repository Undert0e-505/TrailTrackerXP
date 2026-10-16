import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Dimensions,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import Svg, { Path, Polyline, Polygon, Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useTheme } from '../utils/theme';
import {
  getActivityById,
  updateActivity,
  formatDistance,
  formatDurationLong,
  calculateElevationGain,
  calculateElevationLoss,
  getSpeedData,
  getElevationData,
  calculateMovingTime,
} from '../utils/storage';
import { ActivityTypeIcon, ElevationIcon, SpeedIcon } from '../components/Icons';
import { ACTIVITY_TYPES, getActivityLabel, getActivityRouteColor, usesPace } from '../utils/activityTypes';

// Convert icon
const ConvertIcon = ({ size = 24, color = '#424242' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M7 16V4M7 4L3 8M7 4L11 8" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M17 8V20M17 20L21 16M17 20L13 16" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const GRAPH_WIDTH = SCREEN_WIDTH - 32; // Full width minus padding
const GRAPH_HEIGHT = 120;
const GRAPH_PADDING = 40;

export default function ActivityDetailScreen({ route, navigation }) {
  const { activityId } = route.params;
  const { theme, isDark, isMapDark, distanceUnit } = useTheme();
  const [activity, setActivity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [converting, setConverting] = useState(false);
  const webViewRef = useRef(null);

  useEffect(() => {
    loadActivity();
  }, [activityId]);

  useEffect(() => {
    if (mapReady && activity && webViewRef.current) {
      const routeJson = JSON.stringify(activity.route);
      const color = getActivityRouteColor(activity.type);
      webViewRef.current.injectJavaScript(`
        showActivity(${routeJson}, '${color}');
        setDarkMode(${isMapDark});
        true;
      `);
    }
  }, [mapReady, activity, isMapDark]);

  const loadActivity = async () => {
    try {
      const data = await getActivityById(activityId);
      setActivity(data);
    } catch (error) {
      console.error('Error loading activity:', error);
    }
    setLoading(false);
  };

  const handleMapMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'mapReady') {
        setMapReady(true);
      }
    } catch (e) {
      console.log('Map message error:', e);
    }
  };

  const handleConvertType = async (newType) => {
    if (newType === activity.type) return;
    setConverting(true);
    try {
      const updated = await updateActivity(activityId, { type: newType });
      setActivity(updated);
      setShowConvertModal(false);
      
      // Update map route color
      if (webViewRef.current) {
        const routeJson = JSON.stringify(updated.route);
        const color = getActivityRouteColor(newType);
        webViewRef.current.injectJavaScript(`
          showActivity(${routeJson}, '${color}');
          true;
        `);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to convert activity type');
    }
    setConverting(false);
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (!activity) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.text }}>Activity not found</Text>
      </View>
    );
  }

  const elevationGain = activity.elevationGain || calculateElevationGain(activity.route);
  const elevationLoss = calculateElevationLoss(activity.route);
  const movingTime = activity.movingTime || calculateMovingTime(activity.route);
  const speedData = getSpeedData(activity.route);
  const elevationData = getElevationData(activity.route);
  
  const avgSpeed = activity.duration > 0 
    ? (activity.distance / (activity.duration / 3600)) 
    : 0;
  
  const maxSpeed = speedData.length > 0 
    ? Math.max(...speedData.map(s => s.speed)) 
    : 0;

  const avgSpeedDisplay = distanceUnit === 'miles' ? avgSpeed * 0.621371 : avgSpeed;
  const maxSpeedDisplay = distanceUnit === 'miles' ? maxSpeed * 0.621371 : maxSpeed;
  const speedUnit = distanceUnit === 'miles' ? 'mph' : 'km/h';
  const paceUnit = distanceUnit === 'miles' ? 'min/mi' : 'min/km';
  const paceMultiplier = distanceUnit === 'miles' ? 0.621371 : 1;
  const averagePace = avgSpeed > 0 ? 60 / (avgSpeed * paceMultiplier) : 0;
  const bestPace = maxSpeed > 0 ? 60 / (maxSpeed * paceMultiplier) : 0;
  const showPace = usesPace(activity.type);
  const elevUnit = 'm';
  const elevMultiplier = 1;

  const date = new Date(activity.timestamp);
  const formattedDate = date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const formattedTime = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const mapHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; }
    html, body, #map { height: 100%; width: 100%; touch-action: none; }
    .dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', { 
      zoomControl: true, 
      attributionControl: false,
      dragging: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: true
    }).setView([51.5074, -0.1278], 15);
    var layer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    var isDarkMode = false;
    var routeLine = null;

    function setDarkMode(dark) {
      isDarkMode = dark;
      var mapPane = document.querySelector('.leaflet-tile-pane');
      if (mapPane) {
        if (dark) mapPane.classList.add('dark-tiles');
        else mapPane.classList.remove('dark-tiles');
      }
    }

    function showActivity(coords, color) {
      if (!coords || coords.length === 0) return;
      
      var latlngs = coords.map(function(c) { return [c.latitude, c.longitude]; });
      
      routeLine = L.polyline(latlngs, { color: color, weight: 4, opacity: 0.9 }).addTo(map);
      
      L.circleMarker(latlngs[0], {
        radius: 8, fillColor: '#4CAF50', color: '#fff', weight: 2, fillOpacity: 1
      }).addTo(map).bindPopup('Start');
      
      L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 8, fillColor: '#F44336', color: '#fff', weight: 2, fillOpacity: 1
      }).addTo(map).bindPopup('Finish');
      
      // Fit bounds once, then allow free pan/zoom
      map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapReady' }));
  </script>
</body>
</html>
  `;

  // Render elevation graph using react-native-svg
  const renderElevationGraph = () => {
    if (elevationData.length < 2) {
      return (
        <View style={styles.noDataContainer}>
          <Text style={[styles.noDataText, { color: theme.textSecondary }]}>
            No elevation data available
          </Text>
        </View>
      );
    }
    
    const elevations = elevationData.map(d => d.elevation * elevMultiplier);
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const elevRange = maxElev - minElev || 1;
    
    const graphWidth = GRAPH_WIDTH - GRAPH_PADDING;
    const graphHeight = GRAPH_HEIGHT - 20;
    
    const points = elevationData.map((d, i) => {
      const x = GRAPH_PADDING + (i / (elevationData.length - 1)) * graphWidth;
      const y = graphHeight - ((d.elevation * elevMultiplier - minElev) / elevRange) * (graphHeight - 10);
      return `${x},${y}`;
    }).join(' ');
    
    const areaPoints = `${GRAPH_PADDING},${graphHeight} ${points} ${GRAPH_WIDTH},${graphHeight}`;
    
    return (
      <Svg width={GRAPH_WIDTH} height={GRAPH_HEIGHT}>
        <Defs>
          <LinearGradient id="elevGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={theme.primary} stopOpacity="0.4" />
            <Stop offset="100%" stopColor={theme.primary} stopOpacity="0.05" />
          </LinearGradient>
        </Defs>
        <Polygon points={areaPoints} fill="url(#elevGrad)" />
        <Polyline points={points} fill="none" stroke={theme.primary} strokeWidth="2" />
        <SvgText x={4} y={14} fontSize={10} fill={theme.textSecondary}>
          {Math.round(maxElev)} {elevUnit}
        </SvgText>
        <SvgText x={4} y={graphHeight - 2} fontSize={10} fill={theme.textSecondary}>
          {Math.round(minElev)} {elevUnit}
        </SvgText>
      </Svg>
    );
  };

  // Render speed graph using react-native-svg
  const renderSpeedGraph = () => {
    if (speedData.length < 2) {
      return (
        <View style={styles.noDataContainer}>
          <Text style={[styles.noDataText, { color: theme.textSecondary }]}>
            No speed data available
          </Text>
        </View>
      );
    }
    
    const speedMultiplier = distanceUnit === 'miles' ? 0.621371 : 1;
    const speeds = speedData.map(d => d.speed * speedMultiplier);
    const maxSpd = Math.max(...speeds);
    
    const graphWidth = GRAPH_WIDTH - GRAPH_PADDING;
    const graphHeight = GRAPH_HEIGHT - 20;
    
    const points = speedData.map((d, i) => {
      const x = GRAPH_PADDING + (i / (speedData.length - 1)) * graphWidth;
      const y = graphHeight - ((d.speed * speedMultiplier) / maxSpd) * (graphHeight - 10);
      return `${x},${y}`;
    }).join(' ');
    
    const areaPoints = `${GRAPH_PADDING},${graphHeight} ${points} ${GRAPH_WIDTH},${graphHeight}`;
    
    return (
      <Svg width={GRAPH_WIDTH} height={GRAPH_HEIGHT}>
        <Defs>
          <LinearGradient id="speedGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={theme.accent} stopOpacity="0.4" />
            <Stop offset="100%" stopColor={theme.accent} stopOpacity="0.05" />
          </LinearGradient>
        </Defs>
        <Polygon points={areaPoints} fill="url(#speedGrad)" />
        <Polyline points={points} fill="none" stroke={theme.accent} strokeWidth="2" />
        <SvgText x={4} y={14} fontSize={10} fill={theme.textSecondary}>
          {maxSpd.toFixed(1)} {speedUnit}
        </SvgText>
        <SvgText x={4} y={graphHeight - 2} fontSize={10} fill={theme.textSecondary}>
          0
        </SvgText>
      </Svg>
    );
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Map */}
      <View style={styles.mapContainer}>
        <WebView
          ref={webViewRef}
          source={{ html: mapHtml }}
          style={styles.map}
          onMessage={handleMapMessage}
          javaScriptEnabled={true}
          scrollEnabled={true}
          nestedScrollEnabled={true}
        />
      </View>

      {/* Activity Header */}
      <View style={[styles.header, { backgroundColor: theme.cardBg }]}>
        <View style={[styles.headerIcon, { backgroundColor: theme.primaryLight }]}>
          <ActivityTypeIcon type={activity.type} size={32} color={getActivityRouteColor(activity.type)} />
        </View>
        <View style={styles.headerInfo}>
          <Text style={[styles.activityType, { color: theme.text }]}>
            {getActivityLabel(activity.type)}
          </Text>
          <Text style={[styles.activityDate, { color: theme.textSecondary }]}>
            {formattedDate} at {formattedTime}
          </Text>
        </View>
        <TouchableOpacity 
          style={[styles.convertButton, { backgroundColor: theme.surface }]}
          onPress={() => setShowConvertModal(true)}
        >
          <ConvertIcon size={20} color={theme.icon} />
        </TouchableOpacity>
      </View>

      {/* Main Stats */}
      <View style={[styles.statsCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.mainStat}>
          <Text style={[styles.mainStatValue, { color: theme.primary }]}>
            {formatDistance(activity.distance, distanceUnit)}
          </Text>
          <Text style={[styles.mainStatLabel, { color: theme.textSecondary }]}>Total Distance</Text>
        </View>
        
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {formatDurationLong(activity.duration)}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Total Time</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {formatDurationLong(Math.round(movingTime))}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Moving Time</Text>
          </View>
        </View>
        
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {showPace ? `${averagePace.toFixed(1)} ${paceUnit}` : `${avgSpeedDisplay.toFixed(1)} ${speedUnit}`}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{showPace ? 'Avg Pace' : 'Avg Speed'}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>
              {showPace ? `${bestPace.toFixed(1)} ${paceUnit}` : `${maxSpeedDisplay.toFixed(1)} ${speedUnit}`}
            </Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>{showPace ? 'Best Pace' : 'Max Speed'}</Text>
          </View>
        </View>
      </View>

      {/* Elevation Stats */}
      <View style={[styles.statsCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.cardHeader}>
          <ElevationIcon size={20} color={theme.primary} />
          <Text style={[styles.cardTitle, { color: theme.text }]}>Elevation</Text>
        </View>
        
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>+{Math.round(elevationGain * elevMultiplier)} {elevUnit}</Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Gain</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.text }]}>-{Math.round(elevationLoss * elevMultiplier)} {elevUnit}</Text>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Loss</Text>
          </View>
        </View>
        
        <View style={styles.graphContainer}>
          {renderElevationGraph()}
        </View>
      </View>

      {/* Speed Stats */}
      <View style={[styles.statsCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.cardHeader}>
          <SpeedIcon size={20} color={theme.accent} />
          <Text style={[styles.cardTitle, { color: theme.text }]}>Speed</Text>
        </View>
        
        <View style={styles.graphContainer}>
          {renderSpeedGraph()}
        </View>
      </View>

      <View style={{ height: 30 }} />

      {/* Convert Activity Type Modal */}
      <Modal
        visible={showConvertModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowConvertModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg }]}>
            <ConvertIcon size={56} color={theme.primary} />
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Convert Activity?
            </Text>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}>
              Choose a new type for this {getActivityLabel(activity.type).toLowerCase()}.
              {'\n\n'}This updates its GPX file and recalculates stats, XP, achievements and challenges.
            </Text>
            {ACTIVITY_TYPES.map(type => (
              <TouchableOpacity
                key={type.id}
                accessibilityRole="button"
                accessibilityLabel={type.id === activity.type ? `${type.label}, current type` : `Convert to ${type.label}`}
                accessibilityState={{ disabled: converting || type.id === activity.type }}
                style={[
                  styles.modalButton,
                  { backgroundColor: type.id === activity.type ? theme.surface : type.routeColor },
                  type.id === activity.type && { opacity: 0.55 },
                  { marginTop: 8 },
                ]}
                onPress={() => handleConvertType(type.id)}
                disabled={converting || type.id === activity.type}
              >
                <Text style={[styles.modalButtonText, type.id === activity.type && { color: theme.textSecondary }]}>
                  {type.label}{type.id === activity.type ? ' (current)' : ''}
                </Text>
              </TouchableOpacity>
            ))}
            {converting && <ActivityIndicator style={{ marginTop: 12 }} color={theme.primary} />}
            <TouchableOpacity
              style={[styles.modalCancelButton, { backgroundColor: theme.surface }]}
              onPress={() => setShowConvertModal(false)}
              disabled={converting}
            >
              <Text style={[styles.modalCancelButtonText, { color: theme.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mapContainer: {
    height: 250,
    width: '100%',
  },
  map: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
  },
  headerIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  headerInfo: {
    flex: 1,
  },
  activityType: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  activityDate: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  statsCard: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  mainStat: {
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  mainStatValue: {
    fontSize: 36,
    fontFamily: 'Inter_700Bold',
  },
  mainStatLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 4,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
  },
  stat: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  statLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  graphContainer: {
    marginTop: 16,
    alignItems: 'center',
  },
  noDataContainer: {
    height: GRAPH_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noDataText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  convertButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
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
