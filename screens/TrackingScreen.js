import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Linking,
  TextInput,
  Keyboard,
  ScrollView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useTheme } from '../utils/theme';
import { 
  saveActivity, 
  processPostSave, 
  calculateDistance, 
  formatDistance, 
  formatDuration,
  calculateMovingTime,
  calculateElevationGain,
  autoExportActivityGPX,
} from '../utils/storage';
import { ActivityTypeIcon, PlayIcon, StopIcon, MapIcon, DownloadIcon, RecenterIcon, PauseIcon, CheckIcon, CacheSuccessIcon, TrashIcon } from '../components/Icons';
import { ACTIVITY_TYPES, getActivityRouteColor, getDefaultActivityName, usesPace } from '../utils/activityTypes';
import Svg, { Path, Circle } from 'react-native-svg';

const LOCATION_TASK_NAME = 'background-location-task';
const TRACKING_RECOVERY_KEY = '@trail_tracker_recovery_data';
const PENDING_SAVE_KEY = '@trail_tracker_pending_save_activity';

// Global state for background tracking
let backgroundRouteData = [];
let backgroundStartTime = null;
let backgroundActivityType = 'walking';
let backgroundDistanceUnit = 'miles';
let lastAutoSaveTime = 0;
const AUTO_SAVE_INTERVAL = 30000; // Save every 30 seconds

// Auto-save tracking data to AsyncStorage (called from background task)
const autoSaveTrackingData = async () => {
  const now = Date.now();
  if (now - lastAutoSaveTime < AUTO_SAVE_INTERVAL) return;
  lastAutoSaveTime = now;
  
  try {
    const recoveryData = {
      routeData: backgroundRouteData,
      startTime: backgroundStartTime,
      activityType: backgroundActivityType,
      distanceUnit: backgroundDistanceUnit,
      lastSaveTime: now,
    };
    await AsyncStorage.setItem(TRACKING_RECOVERY_KEY, JSON.stringify(recoveryData));
    console.log('Auto-saved tracking data:', backgroundRouteData.length, 'points');
  } catch (e) {
    console.error('Error auto-saving tracking data:', e);
  }
};

// Clear recovery data (called when tracking is properly stopped/saved)
const clearRecoveryData = async () => {
  try {
    await AsyncStorage.removeItem(TRACKING_RECOVERY_KEY);
    console.log('Cleared recovery data');
  } catch (e) {
    console.error('Error clearing recovery data:', e);
  }
};

// Write a pending-save snapshot before attempting final save.
// If the app crashes or save fails, this snapshot can be offered for recovery on next launch.
const writePendingSaveSnapshot = async (activityData) => {
  try {
    const snapshot = {
      ...activityData,
      pendingAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(PENDING_SAVE_KEY, JSON.stringify(snapshot));
    console.log('[pending-save] Snapshot written:', activityData.route?.length, 'points');
  } catch (e) {
    console.error('[pending-save] Error writing snapshot:', e);
  }
};

// Clear the pending-save snapshot after verified save
const clearPendingSaveSnapshot = async () => {
  try {
    await AsyncStorage.removeItem(PENDING_SAVE_KEY);
    console.log('[pending-save] Snapshot cleared');
  } catch (e) {
    console.error('[pending-save] Error clearing snapshot:', e);
  }
};

// Define the background task
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.error('Background location error:', error);
    return;
  }
  if (data) {
    const { locations } = data;
    if (locations && locations.length > 0) {
      const location = locations[0];
      const newCoord = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        altitude: location.coords.altitude || 0,
        speed: location.coords.speed || 0,
        timestamp: location.timestamp,
      };
      
      if (backgroundRouteData.length > 0) {
        newCoord.cumulativeDistance = calculateDistance([...backgroundRouteData, newCoord]);
      } else {
        newCoord.cumulativeDistance = 0;
      }
      
      backgroundRouteData.push(newCoord);
      
      // Auto-save periodically
      autoSaveTrackingData();
    }
  }
});

export default function TrackingScreen() {
  const { theme, isDark, isMapDark, distanceUnit, setUsername } = useTheme();
  const [location, setLocation] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [activityType, setActivityType] = useState('walking');
  const [routeCoordinates, setRouteCoordinates] = useState([]);
  const [distance, setDistance] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [currentAltitude, setCurrentAltitude] = useState(0);
  const [mapStyle, setMapStyle] = useState('osm');
  const [hasPermission, setHasPermission] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successModalContent, setSuccessModalContent] = useState({ title: '', message: '', icon: 'check' });
  const [showDiscardModal, setShowDiscardModal] = useState(false);
  const [isCaching, setIsCaching] = useState(false);
  const [cacheProgress, setCacheProgress] = useState({ current: 0, total: 0 });
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupUsername, setSetupUsername] = useState('');
  const [setupStep, setSetupStep] = useState('name'); // 'name' | 'battery' | 'go'
  const nameInputRef = useRef(null);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [recoveryData, setRecoveryData] = useState(null);
  
  const webViewRef = useRef(null);
  const cachingCancelled = useRef(false);
  const startTime = useRef(null);
  const pausedDuration = useRef(0);
  const durationInterval = useRef(null);
  const appState = useRef(AppState.currentState);
  const locationSubscription = useRef(null);

  const SETUP_COMPLETE_KEY = '@trail_tracker_setup_complete';

  useEffect(() => {
    checkFirstRun();
    checkForRecoveryData();
    checkForPendingSaveSnapshot();
    requestPermissions();
    backgroundDistanceUnit = distanceUnit;
    
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      subscription.remove();
      if (durationInterval.current) {
        clearInterval(durationInterval.current);
      }
      if (locationSubscription.current) {
        locationSubscription.current.remove();
      }
      deactivateKeepAwake();
    };
  }, []);

  // Check for recovery data from interrupted tracking session
  const checkForRecoveryData = async () => {
    try {
      const savedData = await AsyncStorage.getItem(TRACKING_RECOVERY_KEY);
      if (savedData) {
        const parsed = JSON.parse(savedData);
        // Only offer recovery if data is less than 24 hours old
        const ageMs = Date.now() - parsed.lastSaveTime;
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        
        if (ageMs < maxAgeMs && parsed.routeData && parsed.routeData.length > 0) {
          setRecoveryData(parsed);
          setShowRecoveryModal(true);
        } else {
          // Data too old, clear it
          await clearRecoveryData();
        }
      }
    } catch (e) {
      console.log('Error checking recovery data:', e);
    }
  };

  // Check for a pending-save snapshot from a failed save or crash during save
  const checkForPendingSaveSnapshot = async () => {
    try {
      const pending = await AsyncStorage.getItem(PENDING_SAVE_KEY);
      if (pending) {
        const parsed = JSON.parse(pending);
        console.log('[pending-save] Found unsaved activity snapshot:', parsed.route?.length, 'points');
        // Offer the user to retry saving this activity
        Alert.alert(
          'Unsaved Activity Found',
          `An activity from ${parsed.pendingAt ? new Date(parsed.pendingAt).toLocaleString() : 'a previous session'} (${parsed.route?.length || 0} route points, ${formatDistance(parsed.distance || 0, backgroundDistanceUnit)}) was not saved.\n\nWould you like to try saving it now?`,
          [
            { text: 'Discard', style: 'destructive', onPress: () => clearPendingSaveSnapshot() },
            { text: 'Save Now', onPress: async () => {
              try {
                // Check if this activity was already saved (e.g. save succeeded but
                // clearPendingSaveSnapshot didn't run before crash)
                if (parsed.id) {
                  const { isActivitySaved, getActivities } = require('../utils/storage');
                  const alreadyExists = await isActivitySaved(parsed.id);
                  if (alreadyExists) {
                    console.log('[pending-save] Activity already saved, clearing snapshot');
                    await clearPendingSaveSnapshot();
                    Alert.alert('Already Saved', 'This activity was already saved successfully. The recovery snapshot has been cleared.');
                    return;
                  }
                }
                const result = await saveActivity(parsed);
                console.log('[pending-save] Retry save succeeded:', result.activity.id);
                await clearPendingSaveSnapshot();
                Alert.alert('Activity Saved', 'The recovered activity has been saved successfully.');
                // Fire-and-forget gamification processing
                processPostSave(result.activity).catch(e => console.log('[pending-save] Post-save gamification failed:', e.message));
              } catch (error) {
                console.error('[pending-save] Retry save failed:', error);
                Alert.alert('Save Failed', 'Could not save the recovered activity. The snapshot has been kept for another retry.');
              }
            }},
          ]
        );
      }
    } catch (e) {
      console.log('Error checking pending save snapshot:', e);
    }
  };

  // Recover the interrupted tracking session
  const recoverTracking = async () => {
    if (!recoveryData) return;
    
    // Restore the data
    backgroundRouteData = recoveryData.routeData;
    backgroundStartTime = recoveryData.startTime;
    backgroundActivityType = recoveryData.activityType;
    
    // Calculate elapsed duration
    const elapsed = Math.floor((recoveryData.lastSaveTime - recoveryData.startTime) / 1000);
    
    // Update UI state
    setActivityType(recoveryData.activityType);
    setRouteCoordinates(recoveryData.routeData);
    setDistance(calculateDistance(recoveryData.routeData));
    setDuration(elapsed);
    startTime.current = recoveryData.startTime;
    
    setShowRecoveryModal(false);
    setRecoveryData(null);
    
    // Show as paused so user can review and save
    setIsTracking(true);
    setIsPaused(true);
    setShowPauseModal(true);
  };

  // Discard recovery data
  const discardRecovery = async () => {
    await clearRecoveryData();
    setShowRecoveryModal(false);
    setRecoveryData(null);
  };

  const checkFirstRun = async () => {
    try {
      const setupComplete = await AsyncStorage.getItem(SETUP_COMPLETE_KEY);
      if (!setupComplete) {
        setSetupStep('name');
        setShowSetupModal(true);
      }
    } catch (e) {
      console.log('Error checking first run:', e);
    }
  };

  const completeSetup = async () => {
    try {
      // Save username if provided
      if (setupUsername.trim()) {
        await setUsername(setupUsername.trim());
      }
      await AsyncStorage.setItem(SETUP_COMPLETE_KEY, 'true');
      Keyboard.dismiss();
      setShowSetupModal(false);
    } catch (e) {
      console.log('Error saving setup state:', e);
      setShowSetupModal(false);
    }
  };

  const goToBatteryStep = () => {
    nameInputRef.current?.blur();
    Keyboard.dismiss();
    setSetupStep('battery');
  };

  const goToGoStep = () => {
    Keyboard.dismiss();
    setSetupStep('go');
  };

  const openBatterySettings = () => {
    if (Platform.OS === 'android') {
      Linking.openSettings();
    }
  };

  useEffect(() => {
    backgroundDistanceUnit = distanceUnit;
  }, [distanceUnit]);

  const handleAppStateChange = async (nextAppState) => {
    if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
      if (isTracking && !isPaused) {
        console.log('App backgrounded, continuing tracking...');
      }
    } else if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
      if (isTracking && !isPaused) {
        if (backgroundRouteData.length > 0) {
          setRouteCoordinates([...backgroundRouteData]);
          const dist = calculateDistance(backgroundRouteData);
          setDistance(dist);
        }
      }
    }
    appState.current = nextAppState;
  };

  // Auto-pan map to follow location when tracking
  useEffect(() => {
    if (mapReady && location && webViewRef.current) {
      const shouldFollow = isTracking && !isPaused;
      webViewRef.current.injectJavaScript(`
        updateLocation(${location.latitude}, ${location.longitude}, ${shouldFollow});
        true;
      `);
    }
  }, [location, mapReady, isTracking, isPaused]);

  useEffect(() => {
    if (mapReady && webViewRef.current && routeCoordinates.length > 0) {
      const routeJson = JSON.stringify(routeCoordinates.map(c => ({
        latitude: c.latitude,
        longitude: c.longitude
      })));
      const color = getActivityRouteColor(activityType);
      webViewRef.current.injectJavaScript(`
        updateRoute(${routeJson}, '${color}');
        true;
      `);
    }
  }, [routeCoordinates, mapReady, activityType]);

  useEffect(() => {
    if (mapReady && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        changeMapStyle('${mapStyle}');
        setDarkMode(${isMapDark});
        setAppDarkMode(${isDark});
        true;
      `);
    }
  }, [mapStyle, mapReady, isMapDark, isDark]);

  // Recenter map on user location when screen gains focus
  useFocusEffect(
    useCallback(() => {
      const recenterOnFocus = async () => {
        if (mapReady && webViewRef.current) {
          try {
            const currentLocation = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.High,
            });
            const lat = currentLocation.coords.latitude;
            const lng = currentLocation.coords.longitude;
            setLocation({ latitude: lat, longitude: lng });
            webViewRef.current.injectJavaScript(`
              recenterMap(${lat}, ${lng});
              true;
            `);
          } catch (error) {
            console.log('Error getting location on focus:', error);
          }
        }
      };
      recenterOnFocus();
    }, [mapReady])
  );

  const requestPermissions = async () => {
    const { status: foregroundStatus } = await Location.requestForegroundPermissionsAsync();
    if (foregroundStatus !== 'granted') {
      Alert.alert('Permission Denied', 'Location permission is required to track activities.');
      return;
    }
    
    const { status: backgroundStatus } = await Location.requestBackgroundPermissionsAsync();
    if (backgroundStatus !== 'granted') {
      Alert.alert(
        'Background Permission Required',
        'For tracking to work when your screen is off:\n\n1. Enable "Allow all the time" location permission\n2. Disable battery optimization for TrailTrackerXP\n\nGo to Settings > Apps > TrailTrackerXP > Permissions > Location > Allow all the time\n\nThen: Settings > Apps > TrailTrackerXP > Battery > Unrestricted',
        [{ text: 'OK' }]
      );
    }
    
    setHasPermission(true);
    
    try {
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      setLocation({
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      });
      if (currentLocation.coords.altitude) {
        setCurrentAltitude(Math.round(currentLocation.coords.altitude));
      }
    } catch (error) {
      console.log('Error getting initial location:', error);
      setLocation({ latitude: 51.5074, longitude: -0.1278 });
    }
  };

  const startTracking = async () => {
    if (!hasPermission) {
      await requestPermissions();
      return;
    }

    setIsTracking(true);
    setIsPaused(false);
    setRouteCoordinates([]);
    setDistance(0);
    setDuration(0);
    pausedDuration.current = 0;
    startTime.current = Date.now();
    backgroundStartTime = Date.now();
    backgroundRouteData = [];
    backgroundActivityType = activityType;
    
    try {
      await activateKeepAwakeAsync();
    } catch (e) {
      console.log('Keep awake error:', e);
    }

    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`clearRoute(); true;`);
    }

    durationInterval.current = setInterval(() => {
      if (!isPaused) {
        const elapsed = Math.floor((Date.now() - startTime.current) / 1000) - pausedDuration.current;
        setDuration(elapsed);
      }
    }, 1000);

    // Start background location - Android requires a foreground service notification for background GPS
    // Using high priority and sticky notification to prevent suspension
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 2000,
      distanceInterval: 2,
      showsBackgroundLocationIndicator: false,
      activityType: Location.ActivityType.Fitness,
      pausesUpdatesAutomatically: false,
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      foregroundService: {
        notificationTitle: 'TrailTrackerXP Recording',
        notificationBody: 'GPS tracking is active',
        notificationColor: theme.accent,
        killServiceOnDestroy: false,
      },
    });

    // Use a single foreground location watcher for UI updates
    // This doesn't create a separate location indicator
    locationSubscription.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 2000,
        distanceInterval: 2,
        mayShowUserSettingsDialog: false,
      },
      (newLocation) => {
        if (isPaused) return;
        
        const newCoord = {
          latitude: newLocation.coords.latitude,
          longitude: newLocation.coords.longitude,
          altitude: newLocation.coords.altitude || 0,
          speed: newLocation.coords.speed || 0,
          timestamp: Date.now(),
        };
        
        setLocation({
          latitude: newCoord.latitude,
          longitude: newCoord.longitude,
        });
        
        if (newLocation.coords.speed && newLocation.coords.speed > 0) {
          setCurrentSpeed(newLocation.coords.speed * 3.6);
        }
        
        if (newLocation.coords.altitude) {
          setCurrentAltitude(Math.round(newLocation.coords.altitude));
        }
        
        setRouteCoordinates([...backgroundRouteData]);
        setDistance(calculateDistance(backgroundRouteData));
      }
    );
  };

  const pauseTracking = async () => {
    setIsPaused(true);
    setShowPauseModal(true);
  };

  const resumeTracking = async () => {
    setIsPaused(false);
    setShowPauseModal(false);
  };

  const saveTracking = async () => {
    const _st0 = Date.now();
    const _smark = (label) => console.log(`[SAVE_TIMING] saveTracking.${label}: ${Date.now() - _st0}ms`);
    _smark('start');
    
    setShowPauseModal(false);
    
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch (e) {
      console.log('Error stopping location updates:', e);
    }
    _smark('location_stopped');
    
    if (durationInterval.current) {
      clearInterval(durationInterval.current);
      durationInterval.current = null;
    }

    if (locationSubscription.current) {
      locationSubscription.current.remove();
      locationSubscription.current = null;
    }

    deactivateKeepAwake();
    _smark('cleanup_done');
    
    const finalRouteData = backgroundRouteData.length > 0 ? backgroundRouteData : routeCoordinates;

    if (finalRouteData.length > 0) {
      const finalDistance = calculateDistance(finalRouteData);
      const movingTime = calculateMovingTime(finalRouteData);
      const elevationGain = calculateElevationGain(finalRouteData);
      _smark('stats_calculated');
      
      const activity = {
        type: activityType,
        distance: finalDistance,
        duration: duration,
        movingTime: movingTime,
        elevationGain: elevationGain,
        route: finalRouteData,
        date: new Date().toISOString(),
      };
      _smark('activity_object_built');

      // --- Critical save phase: persist + verify ---
      // Route/state is NOT cleared until we confirm the activity is saved.
      // Recovery data is NOT cleared until save is verified.
      // Write a pending-save snapshot so we can recover if save fails or app crashes.
      const activityForSave = { ...activity };
      // Preserve the date as timestamp for consistency
      if (activityForSave.date && !activityForSave.timestamp) {
        activityForSave.timestamp = activityForSave.date;
      }
      _smark('pending_snapshot:start');
      await writePendingSaveSnapshot(activityForSave);
      _smark('pending_snapshot:end');

      let savedActivity = null;

      try {
        _smark('saveActivity:start');
        const result = await saveActivity(activity);
        _smark('saveActivity:end');
        savedActivity = result.activity;
        console.log('[saveTracking] Activity saved and verified:', savedActivity.id);
      } catch (error) {
        // CRITICAL: save failed. Do NOT clear route, distance, duration, or recovery data.
        console.error('[saveTracking] Activity save FAILED:', error);
        _smark('saveActivity:FAILED');
        Alert.alert(
          'Save Failed',
          'Your activity could not be saved. Your current track has been kept so you can try again.\n\nError: ' + (error.message || String(error)),
          [
            { text: 'Retry Save', onPress: () => saveTracking() },
            { text: 'OK', style: 'cancel' },
          ]
        );
        // Restart location tracking infrastructure so the app is in a usable state
        // but keep all tracking data intact for retry
        setIsTracking(false); // show tracking UI as stopped but data preserved
        setIsPaused(true);   // show as paused so user can retry
        return; // Do not proceed to state clearing
      }

      // --- Save verified. Now safe to clear recovery data and pending snapshot. ---
      _smark('clearRecoveryData:start');
      await clearRecoveryData();
      _smark('clearRecoveryData:end');
      _smark('clearPendingSaveSnapshot:start');
      await clearPendingSaveSnapshot();
      _smark('clearPendingSaveSnapshot:end');

      // Await gamification processing (achievements, level-up, challenges).
      // This is now fast -- processPostSave reads AsyncStorage directly instead of
      // calling getActivities() which does FileSystem.readDirectoryAsync().
      _smark('processPostSave:start');
      const postSaveResult = await processPostSave(savedActivity);
      _smark('processPostSave:end');
      const gamification = postSaveResult.gamification;
      const gamificationError = postSaveResult.gamificationError;

      // Auto-export GPX to external storage (non-blocking)
      autoExportActivityGPX(savedActivity).catch(e =>
        console.log('Auto-export GPX failed (non-critical):', e.message)
      );

      // Build success message with gamification info
      let message = `${getDefaultActivityName(activityType)}: ${formatDistance(finalDistance, distanceUnit)} in ${formatDuration(duration)}`;

      if (gamificationError) {
        message += '\n\n\u26a0 XP/challenge updates may need refreshing';
      }

      if (gamification) {
        message += '\n\n+' + gamification.xpEarned + ' XP';

        if (gamification.newLevel) {
          message += '\nLevel Up! ' + gamification.newLevel.name;
        }

        if (gamification.newAchievements && gamification.newAchievements.length > 0) {
          const achievementNames = gamification.newAchievements.map(a => a.name).join('\n');
          message += '\n\nNew Achievement!\n' + achievementNames;
        }

        if (gamification.challengesCompleted && gamification.challengesCompleted.length > 0) {
          message += '\n\nChallenge Complete!';
        }
      }

      setSuccessModalContent({
        title: gamificationError
          ? 'Activity Saved'
          : (gamification?.newLevel ? 'Level Up!' : (gamification?.newAchievements?.length > 0 ? 'Achievement Unlocked!' : 'Activity Saved')),
        message: message,
        icon: 'check'
      });
      setShowSuccessModal(true);
      _smark('success_modal_shown');
    }

    // --- Post-save cleanup: only reached if save succeeded or no route data ---
    setIsTracking(false);
    setIsPaused(false);
    setRouteCoordinates([]);
    setDistance(0);
    setDuration(0);
    setCurrentSpeed(0);
    backgroundRouteData = [];
    backgroundStartTime = null;

    // Clear the route from the map WebView so it's ready for the next activity
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`clearRoute(); true;`);
    }
  };

  const discardTracking = () => {
    setShowPauseModal(false);
    setShowDiscardModal(true);
  };

  const confirmDiscard = async () => {
    setShowDiscardModal(false);
    
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch (e) {
      console.log('Error stopping location updates:', e);
    }
    
    if (durationInterval.current) {
      clearInterval(durationInterval.current);
      durationInterval.current = null;
    }

    if (locationSubscription.current) {
      locationSubscription.current.remove();
      locationSubscription.current = null;
    }

    deactivateKeepAwake();
    
    // Clear recovery data since we're discarding
    await clearRecoveryData();

    setIsTracking(false);
    setIsPaused(false);
    setRouteCoordinates([]);
    setDistance(0);
    setDuration(0);
    setCurrentSpeed(0);
    backgroundRouteData = [];
    backgroundStartTime = null;
    
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(`clearRoute(); true;`);
    }
  };

  const cycleMapStyle = () => {
    const styles = ['osm', 'outdoors', 'cycle'];
    const currentIndex = styles.indexOf(mapStyle);
    const nextIndex = (currentIndex + 1) % styles.length;
    setMapStyle(styles[nextIndex]);
  };

  const getMapStyleLabel = () => {
    switch (mapStyle) {
      case 'osm': return 'Standard';
      case 'outdoors': return 'Outdoors';
      case 'cycle': return 'Cycle';
      default: return 'Standard';
    }
  };

  const recenterMap = () => {
    if (webViewRef.current && location) {
      webViewRef.current.injectJavaScript(`
        recenterMap(${location.latitude}, ${location.longitude});
        true;
      `);
    }
  };

  // Cache ALL map styles at ALL zoom levels
  // Tile cache directory
  const TILE_CACHE_DIR = `${FileSystem.documentDirectory}tile_cache/`;

  // Ensure cache directory exists
  const ensureCacheDir = async () => {
    const dirInfo = await FileSystem.getInfoAsync(TILE_CACHE_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(TILE_CACHE_DIR, { intermediates: true });
    }
  };

  // Get tile file path
  const getTilePath = (style, z, x, y) => {
    return `${TILE_CACHE_DIR}${style}_${z}_${x}_${y}.png`;
  };

  // Check if tile is cached
  const isTileCached = async (style, z, x, y) => {
    const path = getTilePath(style, z, x, y);
    const info = await FileSystem.getInfoAsync(path);
    return info.exists;
  };

  // Download and cache a single tile
  const cacheTile = async (style, z, x, y, url) => {
    const path = getTilePath(style, z, x, y);
    try {
      const downloadResult = await FileSystem.downloadAsync(url, path);
      return downloadResult.status === 200;
    } catch (e) {
      console.log('Tile download failed:', e);
      return false;
    }
  };

  // Get cached tile as base64
  const getCachedTileBase64 = async (style, z, x, y) => {
    const path = getTilePath(style, z, x, y);
    try {
      const base64 = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return `data:image/png;base64,${base64}`;
    } catch (e) {
      return null;
    }
  };

  // Calculate tiles needed for current bounds
  // Note: OSM (Standard) is excluded from caching due to tile usage policy restrictions
  const calculateTiles = (bounds, minZoom, maxZoom) => {
    const tiles = [];
    const styles = ['outdoors', 'cycle']; // OSM excluded - doesn't allow bulk caching
    const subdomains = ['a', 'b', 'c'];
    
    const tileUrls = {
      outdoors: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      cycle: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'
    };
    
    const styleMaxZooms = { outdoors: 17, cycle: 19 };

    styles.forEach(style => {
      const effectiveMaxZoom = Math.min(maxZoom, styleMaxZooms[style]);
      
      for (let z = minZoom; z <= effectiveMaxZoom; z++) {
        // Convert lat/lng bounds to tile coordinates
        const nwX = Math.floor((bounds.west + 180) / 360 * Math.pow(2, z));
        const nwY = Math.floor((1 - Math.log(Math.tan(bounds.north * Math.PI / 180) + 1 / Math.cos(bounds.north * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
        const seX = Math.floor((bounds.east + 180) / 360 * Math.pow(2, z));
        const seY = Math.floor((1 - Math.log(Math.tan(bounds.south * Math.PI / 180) + 1 / Math.cos(bounds.south * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
        
        for (let x = nwX; x <= seX; x++) {
          for (let y = nwY; y <= seY; y++) {
            const subdomain = subdomains[tiles.length % 3];
            const url = tileUrls[style]
              .replace('{s}', subdomain)
              .replace('{z}', z)
              .replace('{x}', x)
              .replace('{y}', y);
            
            tiles.push({ style, z, x, y, url });
          }
        }
      }
    });
    
    return tiles;
  };

  // Main caching function - toggle start/stop
  const cacheAllMaps = async () => {
    if (isCaching) {
      // Stop caching
      cachingCancelled.current = true;
      return;
    }
    
    // Get current map bounds from WebView
    webViewRef.current?.injectJavaScript(`
      var bounds = map.getBounds();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'cacheBounds',
        bounds: {
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        }
      }));
      true;
    `);
  };

  const startCaching = async (bounds) => {
    setIsCaching(true);
    cachingCancelled.current = false;
    await ensureCacheDir();
    
    const tiles = calculateTiles(bounds, 10, 18);
    const total = tiles.length;
    let cached = 0;
    let skipped = 0;
    
    setCacheProgress({ current: 0, total });
    
    // Process tiles in batches for better performance
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < tiles.length; i += BATCH_SIZE) {
      // Check for cancellation
      if (cachingCancelled.current) {
        break;
      }
      
      const batch = tiles.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (tile) => {
        if (cachingCancelled.current) return;
        
        const alreadyCached = await isTileCached(tile.style, tile.z, tile.x, tile.y);
        if (alreadyCached) {
          skipped++;
        } else {
          await cacheTile(tile.style, tile.z, tile.x, tile.y, tile.url);
          cached++;
        }
      }));
      
      setCacheProgress({ current: i + batch.length, total });
    }
    
    setIsCaching(false);
    setCacheProgress({ current: 0, total: 0 });
    
    // Only show success modal if not cancelled
    if (!cachingCancelled.current) {
      setSuccessModalContent({
        title: 'Maps Cached',
        message: `Downloaded ${cached} tiles for Outdoors & Cycle maps.\n${skipped} tiles were already cached.\n\nNote: Standard (OSM) maps are not cached due to usage policy.`,
        icon: 'cache'
      });
      setShowSuccessModal(true);
    }
  };

  // Handle tile request from WebView
  const handleTileRequest = async (style, z, x, y, requestId) => {
    const cached = await isTileCached(style, z, x, y);
    if (cached) {
      const base64 = await getCachedTileBase64(style, z, x, y);
      if (base64) {
        webViewRef.current?.injectJavaScript(`
          window.handleCachedTile('${requestId}', '${base64}');
          true;
        `);
        return;
      }
    }
    // Not cached - tell WebView to use network
    webViewRef.current?.injectJavaScript(`
      window.handleCachedTile('${requestId}', null);
      true;
    `);
  };

  // Auto-cache a tile from base64 data URL
  const autoCacheTile = async (style, z, x, y, dataUrl) => {
    // Only cache if not already cached
    const alreadyCached = await isTileCached(style, z, x, y);
    if (alreadyCached) return;
    
    try {
      await ensureCacheDir();
      const path = getTilePath(style, z, x, y);
      // Extract base64 data from data URL
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      await FileSystem.writeAsStringAsync(path, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch (e) {
      // Silently fail - auto-caching is best-effort
      console.log('Auto-cache failed:', e.message);
    }
  };

  const handleMapMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'mapReady') {
        setMapReady(true);
      } else if (data.type === 'cacheBounds') {
        startCaching(data.bounds);
      } else if (data.type === 'tileRequest') {
        handleTileRequest(data.style, data.z, data.x, data.y, data.requestId);
      }
      // Auto-caching disabled to prevent cache from filling up and corrupting data
    } catch (e) {
      console.log('Map message error:', e);
    }
  };

  const mapHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; }
    html, body, #map { height: 100%; width: 100%; }
    .dark-tiles { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }
    /* Custom zoom control styling */
    .leaflet-control-zoom {
      border: none !important;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2) !important;
    }
    .leaflet-control-zoom a {
      width: 36px !important;
      height: 36px !important;
      line-height: 34px !important;
      font-size: 28px !important;
      font-weight: bold !important;
      border: none !important;
      text-align: center !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .leaflet-control-zoom-in {
      border-radius: 12px 12px 0 0 !important;
    }
    .leaflet-control-zoom-out {
      border-radius: 0 0 12px 12px !important;
    }
    /* Light mode - use accent blue like the rest of the app */
    .leaflet-control-zoom a {
      background-color: #ffffff !important;
      color: #4FC3F7 !important;
    }
    .leaflet-control-zoom a:hover {
      background-color: #f5f5f5 !important;
    }
    /* App dark mode zoom controls */
    .app-dark-mode .leaflet-control-zoom a {
      background-color: #1A1A1A !important;
      color: #4FC3F7 !important;
    }
    .app-dark-mode .leaflet-control-zoom a:hover {
      background-color: #2d2d2d !important;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([51.5074, -0.1278], 16);

    // Store user's current location for zoom centering
    var userLatLng = null;

    // Custom zoom control that centers on user location
    var CustomZoomControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function(map) {
        var container = L.DomUtil.create('div', 'leaflet-control-zoom leaflet-bar leaflet-control');
        
        var zoomIn = L.DomUtil.create('a', 'leaflet-control-zoom-in', container);
        zoomIn.innerHTML = '+';
        zoomIn.href = '#';
        zoomIn.title = 'Zoom in';
        zoomIn.setAttribute('role', 'button');
        zoomIn.setAttribute('aria-label', 'Zoom in');
        
        var zoomOut = L.DomUtil.create('a', 'leaflet-control-zoom-out', container);
        zoomOut.innerHTML = '-';
        zoomOut.href = '#';
        zoomOut.title = 'Zoom out';
        zoomOut.setAttribute('role', 'button');
        zoomOut.setAttribute('aria-label', 'Zoom out');
        
        L.DomEvent.disableClickPropagation(container);
        
        L.DomEvent.on(zoomIn, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          if (userLatLng) {
            map.setZoomAround(userLatLng, map.getZoom() + 1);
          } else {
            map.zoomIn();
          }
        });
        
        L.DomEvent.on(zoomOut, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          if (userLatLng) {
            map.setZoomAround(userLatLng, map.getZoom() - 1);
          } else {
            map.zoomOut();
          }
        });
        
        return container;
      }
    });
    
    map.addControl(new CustomZoomControl());

    var tileUrls = {
      osm: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      outdoors: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      cycle: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'
    };

    var maxZooms = {
      osm: 19,
      outdoors: 17,
      cycle: 19
    };

    // Pending tile requests
    var pendingTileRequests = {};
    var requestIdCounter = 0;

    // Custom tile layer that checks cache first
    var CachedTileLayer = L.TileLayer.extend({
      styleName: 'osm',
      
      initialize: function(url, options, styleName) {
        this.styleName = styleName;
        L.TileLayer.prototype.initialize.call(this, url, options);
      },
      
      createTile: function(coords, done) {
        var tile = document.createElement('img');
        var url = this.getTileUrl(coords);
        var style = this.styleName;
        var requestId = 'tile_' + (requestIdCounter++);
        
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        
        // Request tile from React Native cache - include coords for auto-caching
        pendingTileRequests[requestId] = {
          tile: tile,
          url: url,
          done: done,
          style: style,
          z: coords.z,
          x: coords.x,
          y: coords.y
        };
        
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'tileRequest',
          style: style,
          z: coords.z,
          x: coords.x,
          y: coords.y,
          requestId: requestId
        }));
        
        // Timeout fallback - if no response in 2000ms, use network
        setTimeout(function() {
          if (pendingTileRequests[requestId]) {
            var req = pendingTileRequests[requestId];
            delete pendingTileRequests[requestId];
            req.tile.onload = function() { 
              done(null, req.tile);
            };
            req.tile.onerror = function(e) { done(e, req.tile); };
            req.tile.src = req.url;
          }
        }, 2000);
        
        return tile;
      }
    });

    // Handle cached tile response from React Native
    window.handleCachedTile = function(requestId, base64Data) {
      var req = pendingTileRequests[requestId];
      if (!req) return;
      delete pendingTileRequests[requestId];
      
      if (base64Data) {
        // Use cached tile
        req.tile.onload = function() { req.done(null, req.tile); };
        req.tile.onerror = function(e) { req.done(e, req.tile); };
        req.tile.src = base64Data;
      } else {
        // Not cached - use network (auto-caching disabled to prevent cache overflow)
        req.tile.onload = function() { 
          req.done(null, req.tile);
        };
        req.tile.onerror = function(e) { req.done(e, req.tile); };
        req.tile.src = req.url;
      }
    };

    var tileLayers = {
      osm: new CachedTileLayer(tileUrls.osm, { maxZoom: 19, crossOrigin: true }, 'osm'),
      outdoors: new CachedTileLayer(tileUrls.outdoors, { maxZoom: 17, crossOrigin: true }, 'outdoors'),
      cycle: new CachedTileLayer(tileUrls.cycle, { maxZoom: 19, crossOrigin: true }, 'cycle')
    };

    var currentStyle = 'osm';
    var currentLayer = tileLayers.osm;
    currentLayer.addTo(map);
    var isDarkMode = false;
    var userHasPanned = false;
    var bottomPanelRatio = 0.35;

    var userMarker = null;
    var userCircle = null;
    var routeLine = null;
    var startMarker = null;

    map.on('dragstart', function() {
      userHasPanned = true;
    });

    function setDarkMode(dark) {
      isDarkMode = dark;
      var mapPane = document.querySelector('.leaflet-tile-pane');
      if (mapPane) {
        if (dark) {
          mapPane.classList.add('dark-tiles');
        } else {
          mapPane.classList.remove('dark-tiles');
        }
      }
    }

    function setAppDarkMode(dark) {
      // Toggle app dark mode class on body for zoom controls (separate from map tiles)
      if (dark) {
        document.body.classList.add('app-dark-mode');
      } else {
        document.body.classList.remove('app-dark-mode');
      }
    }

    function getOffsetCenter(latlng) {
      var mapHeight = map.getSize().y;
      var offsetPixels = (mapHeight * bottomPanelRatio) / 2;
      var point = map.latLngToContainerPoint(latlng);
      var offsetPoint = L.point(point.x, point.y + offsetPixels);
      return map.containerPointToLatLng(offsetPoint);
    }

    function updateLocation(lat, lng, shouldFollow) {
      var latlng = L.latLng(lat, lng);
      userLatLng = latlng; // Store for zoom centering
      
      if (userMarker) {
        userMarker.setLatLng(latlng);
        userCircle.setLatLng(latlng);
      } else {
        userMarker = L.circleMarker(latlng, {
          radius: 10,
          fillColor: '#4285F4',
          color: '#fff',
          weight: 3,
          fillOpacity: 1,
          zIndexOffset: 1000
        }).addTo(map);
        
        userCircle = L.circle(latlng, {
          radius: 30,
          fillColor: '#4285F4',
          color: '#4285F4',
          weight: 1,
          fillOpacity: 0.2
        }).addTo(map);
        
        // Initial view with offset
        var offsetCenter = getOffsetCenter(latlng);
        map.setView(offsetCenter, 16);
      }
      
      // Auto-follow only if user hasn't manually panned away
      if (shouldFollow && !userHasPanned) {
        var offsetCenter = getOffsetCenter(latlng);
        map.setView(offsetCenter, map.getZoom(), { animate: true, duration: 0.3 });
      }
    }

    function recenterMap(lat, lng) {
      var latlng = L.latLng(lat, lng);
      userHasPanned = false; // Clear the pan flag when user taps recenter
      var offsetCenter = getOffsetCenter(latlng);
      map.setView(offsetCenter, map.getZoom(), { animate: true });
    }

    function updateRoute(coords, color) {
      var latlngs = coords.map(function(c) { 
        return [c.latitude, c.longitude]; 
      });
      
      if (routeLine) {
        routeLine.setLatLngs(latlngs);
        routeLine.setStyle({ color: color });
      } else {
        routeLine = L.polyline(latlngs, {
          color: color,
          weight: 5,
          opacity: 0.8
        }).addTo(map);
      }
      
      if (latlngs.length > 0 && !startMarker) {
        startMarker = L.circleMarker(latlngs[0], {
          radius: 10,
          fillColor: '#4CAF50',
          color: '#fff',
          weight: 3,
          fillOpacity: 1
        }).addTo(map);
      }
    }

    function clearRoute() {
      if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
      }
      if (startMarker) {
        map.removeLayer(startMarker);
        startMarker = null;
      }
    }

    function changeMapStyle(style) {
      map.removeLayer(currentLayer);
      currentStyle = style;
      currentLayer = tileLayers[style] || tileLayers.osm;
      currentLayer.addTo(map);
      setDarkMode(isDarkMode);
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'mapReady' }));
  </script>
</body>
</html>
  `;

  const styles = createStyles(theme);

  if (!hasPermission) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
          Requesting permissions...
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <WebView
        ref={webViewRef}
        source={{ html: mapHtml }}
        style={styles.map}
        onMessage={handleMapMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        cacheEnabled={true}
        cacheMode="LOAD_CACHE_ELSE_NETWORK"
        startInLoadingState={true}
        renderLoading={() => (
          <View style={[styles.mapLoading, { backgroundColor: theme.surface }]}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={{ color: theme.text }}>Loading map...</Text>
          </View>
        )}
      />

      {/* Recenter button */}
      <TouchableOpacity 
        style={[styles.recenterButton, { backgroundColor: theme.cardBg }]}
        onPress={recenterMap}
      >
        <RecenterIcon size={24} color={theme.primary} />
      </TouchableOpacity>

      <View style={[styles.controlsContainer, { backgroundColor: theme.overlay }]}>
        {/* Activity Type Selector - HIDDEN when tracking */}
        {!isTracking && (
          <View style={styles.activitySelector}>
            {ACTIVITY_TYPES.map(type => (
              <TouchableOpacity
                key={type.id}
                accessibilityRole="button"
                accessibilityState={{ selected: activityType === type.id }}
                accessibilityLabel={`Select ${type.label}`}
                style={[
                  styles.activityButton,
                  { borderColor: theme.border, backgroundColor: theme.cardBg },
                  activityType === type.id && { borderColor: type.routeColor, backgroundColor: theme.primaryLight },
                ]}
                onPress={() => setActivityType(type.id)}
              >
                <ActivityTypeIcon type={type.id} size={26} color={activityType === type.id ? type.routeColor : theme.icon} />
                <Text style={[styles.activityText, { color: theme.text }]}>{type.shortLabel}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Stats display */}
        <View style={styles.statsContainer}>
          <View style={[styles.statBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Distance</Text>
            <Text style={[styles.statValue, { color: theme.primary }]}>{formatDistance(distance, distanceUnit)}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Duration</Text>
            <Text style={[styles.statValue, { color: theme.primary }]}>{formatDuration(duration)}</Text>
          </View>
          <View style={[styles.statBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>
              {usesPace(activityType) ? 'Pace' : 'Speed'}
            </Text>
            <Text style={[styles.statValue, { color: theme.primary }]}>
              {currentSpeed > 0 
                ? (usesPace(activityType)
                    ? `${(60 / (currentSpeed * (distanceUnit === 'miles' ? 0.621371 : 1))).toFixed(1)}'/${distanceUnit === 'miles' ? 'mi' : 'km'}`
                    : `${(currentSpeed * (distanceUnit === 'miles' ? 0.621371 : 1)).toFixed(1)} ${distanceUnit === 'miles' ? 'mph' : 'km/h'}`)
                : '--'
              }
            </Text>
          </View>
        </View>

        {/* Secondary stats */}
        <View style={styles.statsContainer}>
          <View style={[styles.statBox, { backgroundColor: theme.surface }]}>
            <Text style={[styles.statLabel, { color: theme.textSecondary }]}>Elevation</Text>
            <Text style={[styles.statValue, { color: theme.primary }]}>
              {`${currentAltitude} m`}
            </Text>
          </View>
          <TouchableOpacity 
            style={[styles.statBox, styles.mapStyleBox, { backgroundColor: theme.surface }]}
            onPress={cycleMapStyle}
          >
            <MapIcon size={18} color={theme.icon} />
            <Text style={[styles.mapStyleText, { color: theme.text }]}>{getMapStyleLabel()}</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.statBox, styles.cacheBox, { backgroundColor: theme.surface }]}
            onPress={cacheAllMaps}
          >
            <DownloadIcon size={18} color={isCaching ? theme.danger : theme.icon} />
            <Text style={[styles.mapStyleText, { color: isCaching ? theme.danger : theme.text }]}>
              {isCaching 
                ? `Stop (${cacheProgress.current}/${cacheProgress.total})` 
                : 'Cache Area'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Start/Pause button */}
        {!isTracking ? (
          <TouchableOpacity
            style={[styles.trackButton, { backgroundColor: theme.primary }]}
            onPress={startTracking}
          >
            <PlayIcon size={24} color="#fff" />
            <Text style={styles.trackButtonText}>Start Tracking</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.trackButton, { backgroundColor: theme.pauseButton }]}
            onPress={pauseTracking}
          >
            <PauseIcon size={24} color="#fff" />
            <Text style={styles.trackButtonText}>Pause</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Pause Modal */}
      <Modal
        visible={showPauseModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowPauseModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Activity Paused</Text>
            <Text style={[styles.modalStats, { color: theme.textSecondary }]}>
              {formatDistance(distance, distanceUnit)} - {formatDuration(duration)}
            </Text>
            
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: theme.primary }]}
              onPress={resumeTracking}
            >
              <PlayIcon size={20} color="#fff" />
              <Text style={styles.modalButtonText}>Resume</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: theme.accent }]}
              onPress={saveTracking}
            >
              <StopIcon size={20} color="#fff" />
              <Text style={styles.modalButtonText}>Save Activity</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: theme.danger }]}
              onPress={discardTracking}
            >
              <Text style={styles.modalButtonText}>Discard</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Success Modal - styled confirmation for saves and caching */}
      <Modal
        visible={showSuccessModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowSuccessModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.successModalContent, { backgroundColor: theme.cardBg }]}>
            {successModalContent.icon === 'check' ? (
              <CheckIcon size={56} color={theme.primary} />
            ) : (
              <CacheSuccessIcon size={56} color={theme.accent} />
            )}
            <Text style={[styles.successModalTitle, { color: theme.text }]}>
              {successModalContent.title}
            </Text>
            <Text style={[styles.successModalMessage, { color: theme.textSecondary }]}>
              {successModalContent.message}
            </Text>
            <TouchableOpacity
              style={[styles.successModalButton, { backgroundColor: theme.primary }]}
              onPress={() => setShowSuccessModal(false)}
            >
              <Text style={styles.successModalButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Discard Confirmation Modal */}
      <Modal
        visible={showDiscardModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowDiscardModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.successModalContent, { backgroundColor: theme.cardBg }]}>
            <TrashIcon size={56} color={theme.danger} />
            <Text style={[styles.successModalTitle, { color: theme.text }]}>
              Discard Activity?
            </Text>
            <Text style={[styles.successModalMessage, { color: theme.textSecondary }]}>
              This cannot be undone.
            </Text>
            <TouchableOpacity
              style={[styles.successModalButton, { backgroundColor: theme.danger }]}
              onPress={confirmDiscard}
            >
              <Text style={styles.successModalButtonText}>Discard</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.discardCancelButton, { backgroundColor: theme.surface }]}
              onPress={() => {
                setShowDiscardModal(false);
                setShowPauseModal(true);
              }}
            >
              <Text style={[styles.discardCancelButtonText, { color: theme.text }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* First Run Setup Modal ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â 3-step guided onboarding */}
      <Modal
        visible={showSetupModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.modalOverlay}>
          <ScrollView contentContainerStyle={styles.setupScrollContent} keyboardShouldPersistTaps="handled">
            <View style={[styles.setupModalContent, { backgroundColor: theme.cardBg }]}>
              <View style={[styles.setupIconContainer, { backgroundColor: theme.primaryLight }]}>
                <RecenterIcon size={40} color={theme.primary} />
              </View>
              <Text style={[styles.setupModalTitle, { color: theme.text }]}>
                Welcome to TrailTrackerXP!
              </Text>
              <Text style={[styles.setupModalSubtitle, { color: theme.textSecondary }]}>
                {setupStep === 'name' ? 'Step 1 of 3: What\u2019s your name?' : setupStep === 'battery' ? 'Step 2 of 3: Battery Settings' : 'Step 3 of 3: Ready to Go'}
              </Text>

              {/* Step 1: NAME */}
              {setupStep === 'name' && (
                <>
                  <View style={[styles.setupInputBox, { backgroundColor: theme.surface }]}>
                    <TextInput
                      ref={nameInputRef}
                      style={[styles.setupInput, {
                        backgroundColor: theme.cardBg,
                        color: theme.text,
                        borderColor: theme.border,
                      }]}
                      placeholder="Enter your name"
                      placeholderTextColor={theme.textSecondary}
                      value={setupUsername}
                      onChangeText={setSetupUsername}
                      autoCapitalize="words"
                      maxLength={20}
                      returnKeyType="next"
                      autoFocus={true}
                      onSubmitEditing={goToBatteryStep}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: theme.primary }]}
                    onPress={goToBatteryStep}
                  >
                    <Text style={styles.setupButtonText}>Continue</Text>
                  </TouchableOpacity>
                </>
              )}

              {/* Step 2: BATTERY */}
              {setupStep === 'battery' && (
                <>
                  <View style={[styles.setupInstructionBox, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.setupInstructionTitle, { color: theme.text }]}>
                      Disable Battery Optimization
                    </Text>
                    <Text style={[styles.setupInstructionText, { color: theme.textSecondary }]}>
                      For tracking to work with the screen off:
                    </Text>
                    <View style={styles.setupSteps}>
                      <Text style={[styles.setupStep, { color: theme.text }]}>
                        Settings ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Apps ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ TrailTrackerXP ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Battery ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Unrestricted
                      </Text>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: theme.primary }]}
                    onPress={openBatterySettings}
                  >
                    <Text style={styles.setupButtonText}>Open Settings</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.setupSecondaryButton, { backgroundColor: theme.surface }]}
                    onPress={goToGoStep}
                  >
                    <Text style={[styles.setupSecondaryButtonText, { color: theme.text }]}>
                      Continue
                    </Text>
                  </TouchableOpacity>
                </>
              )}

              {/* Step 3: LET'S GO */}
              {setupStep === 'go' && (
                <>
                  <View style={[styles.setupInstructionBox, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.setupInstructionText, { color: theme.textSecondary }]}>
                      {setupUsername.trim() ? `You\u2019re all set up, ${setupUsername.trim()}!` : 'You\u2019re all set up!'}
                    </Text>
                    <Text style={[styles.setupInstructionText, { color: theme.textSecondary, marginTop: 8 }]}>
                      You can now start tracking your activities. If you skipped the battery settings, you can always do it later from the app menu.
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.setupButton, { backgroundColor: theme.primary }]}
                    onPress={completeSetup}
                  >
                    <Text style={styles.setupButtonText}>
                      {setupUsername.trim() ? `Let\u2019s Go, ${setupUsername.trim()}!` : 'Get Started'}
                    </Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Recovery Modal */}
      <Modal
        visible={showRecoveryModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg }]}>
            <View style={[styles.modalIconContainer, { backgroundColor: 'rgba(255, 152, 0, 0.1)' }]}>
              <RecenterIcon size={32} color={theme.warning} />
            </View>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              Recover Activity?
            </Text>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}>
              {recoveryData ? `Found an interrupted ${recoveryData.activityType} session with ${recoveryData.routeData.length} GPS points.\n\nDistance: ${formatDistance(calculateDistance(recoveryData.routeData), distanceUnit)}\nDuration: ${formatDuration(Math.floor((recoveryData.lastSaveTime - recoveryData.startTime) / 1000))}` : 'Recovery data found.'}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary, { backgroundColor: theme.surface }]}
                onPress={discardRecovery}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Discard</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary, { backgroundColor: theme.primary }]}
                onPress={recoverTracking}
              >
                <Text style={[styles.modalButtonText, { color: '#fff' }]}>Recover</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (theme) => StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  mapLoading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
  },
  recenterButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  activitySelector: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  activityButton: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 2,
    gap: 4,
  },
  activityText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  statsContainer: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  statBox: {
    flex: 1,
    padding: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  statLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statValue: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  mapStyleBox: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  cacheBox: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  mapStyleText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  trackButton: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  trackButtonText: {
    color: '#fff',
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
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
    maxWidth: 340,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginBottom: 8,
  },
  modalStats: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
    marginBottom: 24,
  },
  modalButton: {
    flexDirection: 'row',
    width: '100%',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 12,
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  successModalContent: {
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
  successModalTitle: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginTop: 20,
    marginBottom: 8,
    textAlign: 'center',
  },
  successModalMessage: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  successModalButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  successModalButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  discardCancelButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  discardCancelButtonText: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  // Setup Modal Styles
  setupScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 20,
  },
  setupModalContent: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 24,
    padding: 28,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  setupIconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  setupModalTitle: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginBottom: 4,
  },
  setupModalSubtitle: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    marginBottom: 20,
  },
  setupInstructionBox: {
    width: '100%',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  setupInputBox: {
    width: '100%',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  setupInputLabel: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    marginBottom: 10,
  },
  setupInput: {
    width: '100%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
  },
  setupInstructionTitle: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    marginBottom: 8,
  },
  setupInstructionText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 20,
    marginBottom: 12,
  },
  setupSteps: {
    gap: 6,
  },
  setupStep: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    lineHeight: 20,
  },
  setupButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  setupButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  setupSecondaryButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  setupSecondaryButtonText: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
});
