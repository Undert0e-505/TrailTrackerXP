import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { processActivity, recalculateGamification, loadGamification } from './gamification';
import {
  initFileStorage, 
  saveActivityToFile, 
  deleteActivityFromFile,
  loadActivitiesFromFile,
  loadActivityFromFile,
  loadActivityWithStreams,
  loadRouteFromFile,
  enrichActivitiesWithRoutes,
  syncCacheToFile,
  recoverFromFileStorage,
  exportCacheToFileStorage,
  saveGamificationToFile,
  loadGamificationFromFile,
  getStorageStats,
  verifyDataIntegrity,
  createFullExport,
  exportGPXFiles,
  isActivitySaved,
  getSavedActivityIds,
  getGPXFilePath,
  getAllGPXFilePaths,
} from './fileStorage';

const ACTIVITIES_KEY = '@trail_tracker_activities';
const CACHED_TILES_KEY = '@trail_tracker_cached_tiles';
const TILE_CACHE_DIR = `${FileSystem.documentDirectory}tile_cache/`;

// Re-export file storage functions for use elsewhere
export {
  initFileStorage,
  exportCacheToFileStorage,
  recoverFromFileStorage,
  getStorageStats,
  verifyDataIntegrity,
  createFullExport,
  saveGamificationToFile,
  loadGamificationFromFile,
  exportGPXFiles,
  getGPXFilePath,
  getAllGPXFilePaths,
  loadRouteFromFile,
  enrichActivitiesWithRoutes,
  isActivitySaved,
  getSavedActivityIds,
  loadActivityFromFile,
};

// Strip route data from an activity for lightweight AsyncStorage caching.
// Full route data lives in GPX files -- AsyncStorage only holds metadata.
const stripRouteForCache = (activity) => {
  const { route, routeData, ...metadata } = activity;
  return metadata;
};

export const saveActivity = async (activity) => {
  const _t0 = Date.now();
  const _mark = (label) => console.log(`[SAVE_TIMING] ${label}: ${Date.now() - _t0}ms`);
  _mark('saveActivity:start');

  // --- Phase 1 ONLY: Critical persistence (GPX file + AsyncStorage cache) ---
  // If this succeeds, the activity is saved. We return immediately so the UI
  // can confirm "Activity Saved". Gamification/achievements/challenges run
  // later via processPostSave() (fire-and-forget from the caller).
  let newActivity;
  try {
    // If the incoming activity already has an id (e.g. from pending-save recovery),
    // check whether it's already been saved to avoid duplicates.
    if (activity.id) {
      _mark('isActivitySaved(check existing):start');
      const alreadySaved = await isActivitySaved(activity.id);
      _mark('isActivitySaved(check existing):end');
      if (alreadySaved) {
        console.log('[save] Activity already exists in GPX storage, skipping re-save:', activity.id);
        // Ensure it's in the AsyncStorage cache too, then return early.
        // Read AsyncStorage directly instead of calling getActivities() (avoids folder enumeration).
        _mark('AsyncStorage.getItem(existing):start');
        const json = await AsyncStorage.getItem(ACTIVITIES_KEY);
        _mark('AsyncStorage.getItem(existing):end');
        const existing = json ? JSON.parse(json) : [];
        if (!existing.some(a => a.id === activity.id)) {
          const fileActivity = await loadActivityFromFile(activity.id);
          if (fileActivity) {
            const updated = [...existing, stripRouteForCache(fileActivity)];
            await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(updated));
          }
        }
        _mark('saveActivity:done(already existed)');
        return { activity: { ...activity, timestamp: activity.timestamp || activity.date }, gamification: null, gamificationError: null, alreadyExisted: true };
      }
    }

    _mark('build activity object');
    newActivity = {
      id: activity.id || Date.now().toString(),
      timestamp: activity.timestamp || new Date().toISOString(),
      ...activity,
    };
    // Ensure id and timestamp take precedence over spread activity fields
    if (activity.id) {
      newActivity.id = activity.id;
    }
    if (activity.timestamp) {
      newActivity.timestamp = activity.timestamp;
    }

    // Save full activity (with route) to GPX file first -- this is the source of truth
    _mark('saveActivityToFile:start');
    const fileResult = await saveActivityToFile(newActivity);
    _mark('saveActivityToFile:end');
    if (!fileResult) {
      throw new Error('saveActivityToFile returned false ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â GPX persistence failed');
    }
    console.log('[save] Activity persisted to file:', newActivity.id);

    // Verify the GPX file actually exists on disk
    _mark('isActivitySaved(verify):start');
    const verified = await isActivitySaved(newActivity.id);
    _mark('isActivitySaved(verify):end');
    if (!verified) {
      throw new Error('Save verification failed ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â GPX file not found after write');
    }
    console.log('[save] Activity verified on disk:', newActivity.id);

    // Cache only metadata in AsyncStorage (no route data -- prevents size limit corruption).
    // Dedupe: replace existing entry with same id instead of appending a duplicate.
    // Read AsyncStorage directly instead of calling getActivities() to avoid
    // folder enumeration + dedup + orphan-cleanup on every save.
    _mark('AsyncStorage.getItem(cache):start');
    const json = await AsyncStorage.getItem(ACTIVITIES_KEY);
    _mark('AsyncStorage.getItem(cache):end');
    const existingActivities = json ? JSON.parse(json) : [];
    const filteredExisting = existingActivities.filter(a => a.id !== newActivity.id);
    const updatedActivities = [...filteredExisting, stripRouteForCache(newActivity)];
    _mark('AsyncStorage.setItem(cache):start');
    await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(updatedActivities));
    _mark('AsyncStorage.setItem(cache):end');
    console.log('[save] Activity cached to AsyncStorage:', newActivity.id);
  } catch (error) {
    console.error('[save] CRITICAL: Activity persistence failed:', error);
    _mark('saveActivity:FAILED(phase1)');
    throw error; // This is a real save failure
  }

  _mark('phase1_complete (UI can confirm now)');

  // Return immediately. Phase 2 is the caller's responsibility (fire-and-forget).
  return { activity: newActivity, gamification: null, gamificationError: null };
};

/**
 * Post-save processing: gamification, challenges, gamification file persistence.
 * This is non-critical -- the activity is already safely saved to disk.
 * Callers should fire-and-forget this (e.g. .catch() without await).
 */
export const processPostSave = async (activity) => {
  const _t0 = Date.now();
  const _mark = (label) => console.log(`[SAVE_TIMING] postSave.${label}: ${Date.now() - _t0}ms`);
  _mark('start');

  let gamificationResults = null;
  let gamificationError = null;
  try {
    // Read activities from AsyncStorage directly instead of calling getActivities().
    // getActivities() does FileSystem.readDirectoryAsync() (folder enumeration +
    // dedup + orphan cleanup) which is the main bottleneck. The cache was just
    // updated in Phase 1, so it's current. Append the activity we just saved
    // (already in the cache, but we pass it explicitly to be safe).
    _mark('AsyncStorage.getItem:start');
    const json = await AsyncStorage.getItem(ACTIVITIES_KEY);
    _mark('AsyncStorage.getItem:end');
    const cachedActivities = json ? JSON.parse(json) : [];
    // Ensure the just-saved activity is in the list (it should already be,
    // but this is a safety net in case the cache write hasn't flushed yet)
    let updatedActivities = cachedActivities;
    if (!cachedActivities.some(a => a.id === activity.id)) {
      updatedActivities = [...cachedActivities, stripRouteForCache(activity)];
    }

    _mark('processActivity:start');
    gamificationResults = await processActivity(activity, updatedActivities);
    _mark('processActivity:end');
    console.log('[postSave] Gamification processed for:', activity.id);

    // Also save gamification to file storage
    _mark('loadGamification:start');
    const gamificationData = await loadGamification();
    _mark('loadGamification:end');
    _mark('saveGamificationToFile:start');
    await saveGamificationToFile(gamificationData);
    _mark('saveGamificationToFile:end');
    console.log('[postSave] Gamification persisted for:', activity.id);
  } catch (error) {
    console.error('[postSave] Gamification processing failed (activity already saved):', error);
    gamificationError = error.message || String(error);
  }

  _mark('done');
  return { gamification: gamificationResults, gamificationError };
};

// Update an existing activity (e.g., change type)
export const updateActivity = async (id, updates) => {
  try {
    const activities = await getActivities();
    const index = activities.findIndex(a => a.id === id);
    if (index === -1) throw new Error('Activity not found');

    activities[index] = { ...activities[index], ...updates };

    // Update GPX file with full data (load route from file if needed)
    const fullActivity = { ...activities[index] };
    if (!fullActivity.route && !fullActivity.routeData) {
      const route = await loadRouteFromFile(id);
      if (route) fullActivity.route = route;
    }
    await saveActivityToFile(fullActivity);

    // Cache only metadata in AsyncStorage
    await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(activities.map(stripRouteForCache)));

    // Recalculate gamification since activity type may affect achievements
    await recalculateGamification(activities);

    // Also save gamification to file storage
    const gamificationData = await loadGamification();
    await saveGamificationToFile(gamificationData);

    return { ...activities[index], route: fullActivity.route || fullActivity.routeData || [] };
  } catch (error) {
    console.error('Error updating activity:', error);
    throw error;
  }
};

export const getActivities = async () => {
  const _t0 = Date.now();
  try {
    const _t1 = Date.now();
    const json = await AsyncStorage.getItem(ACTIVITIES_KEY);
    const cachedActivities = json ? JSON.parse(json) : [];
    console.log(`[SAVE_TIMING] getActivities.AsyncStorage: ${Date.now() - _t1}ms (${cachedActivities.length} cached)`);

    // Get all GPX file IDs (source of truth)
    const savedIds = new Set(await getSavedActivityIds());

    if (cachedActivities.length > 0) {
      // Merge: keep cache entries that have a backing GPX file,
      // and add file-only entries that are missing from cache.
      const cacheIds = new Set(cachedActivities.map(a => a.id?.toString()));
      const validFromCache = cachedActivities.filter(a => savedIds.has(a.id?.toString()));
      const orphanedFromCache = cachedActivities.filter(a => !savedIds.has(a.id?.toString()));
      if (orphanedFromCache.length > 0) {
        console.log(`[getActivities] Dropping ${orphanedFromCache.length} orphaned cache entr(y/ies) with no GPX file`);
        // Clean AsyncStorage to remove orphans
        await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(validFromCache.map(stripRouteForCache)));
      }

      // Check for GPX files not in cache (e.g. cache is partial)
      const missingFromCache = [...savedIds].filter(id => !cacheIds.has(id));
      if (missingFromCache.length > 0) {
        console.log(`[getActivities] Found ${missingFromCache.length} GPX file(s) not in cache, merging`);
        const fileActivities = await loadActivitiesFromFile();
        const toAdd = fileActivities.filter(a => !cacheIds.has(a.id?.toString()));
        const merged = [...validFromCache, ...toAdd.map(({ route, routeData, ...metadata }) => metadata)];
        // Dedupe by id (shouldn't be needed after above logic, but guarantees no duplicates)
        const seen = new Set();
        const deduped = merged.filter(a => {
          const id = a.id?.toString();
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(deduped.map(stripRouteForCache)));
        console.log(`[SAVE_TIMING] getActivities.total: ${Date.now() - _t0}ms (merged, ${deduped.length} activities)`);
        return deduped;
      }

      // Dedupe by id (safety net)
      const seen = new Set();
      const deduped = validFromCache.filter(a => {
        const id = a.id?.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      console.log(`[SAVE_TIMING] getActivities.total: ${Date.now() - _t0}ms (cache hit, ${deduped.length} activities)`);
      return deduped;
    }

    // Cache is empty -- try to rebuild from GPX files (source of truth)
    const fileActivities = await loadActivitiesFromFile();
    if (fileActivities.length > 0) {
      console.log(`Cache empty, rebuilt from ${fileActivities.length} GPX files`);
      const stripped = fileActivities.map(({ route, routeData, ...metadata }) => metadata);
      await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(stripped));
      console.log(`[SAVE_TIMING] getActivities.total: ${Date.now() - _t0}ms (rebuilt from files, ${stripped.length} activities)`);
      return stripped;
    }
    console.log(`[SAVE_TIMING] getActivities.total: ${Date.now() - _t0}ms (empty)`);
    return [];
  } catch (error) {
    console.error('Error getting activities, attempting GPX recovery:', error);
    console.log(`[SAVE_TIMING] getActivities.total: ${Date.now() - _t0}ms (ERROR path)`);
    try {
      const fileActivities = await loadActivitiesFromFile();
      if (fileActivities.length > 0) {
        const stripped = fileActivities.map(({ route, routeData, ...metadata }) => metadata);
        await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(stripped));
        return stripped;
      }
    } catch (recoveryError) {
      console.error('GPX recovery also failed:', recoveryError);
    }
    return [];
  }
};

export const getActivityById = async (id) => {
  try {
    const activities = await getActivities();
    const activity = activities.find(a => a.id === id) || null;

    if (activity) {
      // If activity doesn't have route data, try to load from GPX
      if (!activity.route || activity.route.length === 0) {
        const route = await loadRouteFromFile(id);
        if (route) {
          activity.route = route;
        }
      }
    }

    return activity;
  } catch (error) {
    console.error('Error getting activity:', error);
    return null;
  }
};

export const deleteActivity = async (id) => {
  try {
    const activities = await getActivities();
    // Filter out the activity (and any duplicates with the same id)
    const filteredActivities = activities.filter(a => a.id !== id);
    await AsyncStorage.setItem(ACTIVITIES_KEY, JSON.stringify(filteredActivities));

    // Also delete from file storage
    await deleteActivityFromFile(id);

    // Recalculate gamification based on remaining activities
    await recalculateGamification(filteredActivities);

    // Also save gamification to file storage
    const gamificationData = await loadGamification();
    await saveGamificationToFile(gamificationData);
  } catch (error) {
    console.error('Error deleting activity:', error);
    throw error;
  }
};

export const calculateDistance = (coords) => {
  if (!coords || coords.length < 2) return 0;

  let totalDistance = 0;
  for (let i = 1; i < coords.length; i++) {
    totalDistance += getDistanceBetweenPoints(
      coords[i - 1].latitude,
      coords[i - 1].longitude,
      coords[i].latitude,
      coords[i].longitude
    );
  }
  return totalDistance;
};

// Haversine formula for distance calculation (returns km)
const getDistanceBetweenPoints = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRad = (deg) => deg * (Math.PI / 180);

// Convert km to miles
const kmToMiles = (km) => km * 0.621371;

// Format distance with unit preference (km is stored value)
// When miles selected: always show miles (no yards/feet conversion)
// When km selected: show metres for small distances, km for larger
export const formatDistance = (km, unit = 'miles') => {
  if (km === undefined || km === null) return unit === 'miles' ? '0.00 mi' : '0 m';

  if (unit === 'miles') {
    const miles = kmToMiles(km);
    return `${miles.toFixed(2)} mi`;
  } else {
    if (km < 1) {
      return `${Math.round(km * 1000)} m`;
    }
    return `${km.toFixed(2)} km`;
  }
};

// Get raw distance in preferred unit
export const getDistanceInUnit = (km, unit = 'miles') => {
  if (unit === 'miles') {
    return kmToMiles(km);
  }
  return km;
};

export const formatDuration = (seconds) => {
  if (!seconds) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
};

export const formatDurationLong = (seconds) => {
  if (!seconds) return '0:00:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// Calculate moving time (time when speed > threshold)
export const calculateMovingTime = (routeData) => {
  if (!routeData || routeData.length < 2) return 0;

  let movingTime = 0;
  const speedThreshold = 0.5; // km/h minimum to count as moving

  for (let i = 1; i < routeData.length; i++) {
    const timeDiff = (routeData[i].timestamp - routeData[i-1].timestamp) / 1000; // seconds
    if (timeDiff <= 0) continue;

    const distance = getDistanceBetweenPoints(
      routeData[i-1].latitude,
      routeData[i-1].longitude,
      routeData[i].latitude,
      routeData[i].longitude
    );
    const speed = (distance / timeDiff) * 3600; // km/h

    if (speed > speedThreshold) {
      movingTime += timeDiff;
    }
  }

  return movingTime;
};

// Calculate elevation gain
export const calculateElevationGain = (routeData) => {
  if (!routeData || routeData.length < 2) return 0;

  let gain = 0;
  for (let i = 1; i < routeData.length; i++) {
    const elevDiff = (routeData[i].altitude || 0) - (routeData[i-1].altitude || 0);
    if (elevDiff > 0) {
      gain += elevDiff;
    }
  }
  return Math.round(gain);
};

// Calculate elevation loss
export const calculateElevationLoss = (routeData) => {
  if (!routeData || routeData.length < 2) return 0;

  let loss = 0;
  for (let i = 1; i < routeData.length; i++) {
    const elevDiff = (routeData[i].altitude || 0) - (routeData[i-1].altitude || 0);
    if (elevDiff < 0) {
      loss += Math.abs(elevDiff);
    }
  }
  return Math.round(loss);
};

// Get speed data for graphing (smoothed over ~5 seconds)
export const getSpeedData = (routeData) => {
  if (!routeData || routeData.length < 2) return [];

  const rawSpeeds = [];
  for (let i = 1; i < routeData.length; i++) {
    const timeDiff = (routeData[i].timestamp - routeData[i-1].timestamp) / 1000;
    if (timeDiff <= 0) continue;

    const distance = getDistanceBetweenPoints(
      routeData[i-1].latitude,
      routeData[i-1].longitude,
      routeData[i].latitude,
      routeData[i].longitude
    );
    const speed = (distance / timeDiff) * 3600; // km/h

    rawSpeeds.push({
      time: (routeData[i].timestamp - routeData[0].timestamp) / 1000 / 60,
      timestamp: routeData[i].timestamp,
      speed: Math.min(speed, 100),
      distance: routeData[i].cumulativeDistance || 0,
    });
  }

  // Smooth speeds using a 10-second rolling average for cleaner graphs
  const smoothedSpeeds = [];
  const smoothingWindow = 10000; // 10 seconds in ms

  for (let i = 0; i < rawSpeeds.length; i++) {
    const currentTime = rawSpeeds[i].timestamp;
    let sumSpeed = 0;
    let count = 0;

    // Look back and forward within the window
    for (let j = 0; j < rawSpeeds.length; j++) {
      if (Math.abs(rawSpeeds[j].timestamp - currentTime) <= smoothingWindow / 2) {
        sumSpeed += rawSpeeds[j].speed;
        count++;
      }
    }

    smoothedSpeeds.push({
      time: rawSpeeds[i].time,
      speed: count > 0 ? sumSpeed / count : rawSpeeds[i].speed,
      distance: rawSpeeds[i].distance,
    });
  }

  return smoothedSpeeds;
};

// Get elevation data for graphing
export const getElevationData = (routeData) => {
  if (!routeData || routeData.length < 1) return [];

  return routeData
    .filter(point => point.altitude !== undefined && point.altitude !== null)
    .map((point, index) => ({
      distance: point.cumulativeDistance || 0,
      elevation: Math.round(point.altitude),
      time: (point.timestamp - routeData[0].timestamp) / 1000 / 60,
    }));
};

// Tile caching
export const cacheTiles = async (bounds, zoomLevels = [13, 14, 15, 16]) => {
  try {
    const cached = await getCachedTileRegions();
    const newRegion = {
      id: Date.now().toString(),
      bounds,
      zoomLevels,
      timestamp: new Date().toISOString(),
    };
    cached.push(newRegion);
    await AsyncStorage.setItem(CACHED_TILES_KEY, JSON.stringify(cached));
    return newRegion;
  } catch (error) {
    console.error('Error caching tiles:', error);
    throw error;
  }
};

export const getCachedTileRegions = async () => {
  try {
    const cached = await AsyncStorage.getItem(CACHED_TILES_KEY);
    return cached ? JSON.parse(cached) : [];
  } catch (error) {
    console.error('Error getting cached tiles:', error);
    return [];
  }
};

export const clearCachedTiles = async () => {
  try {
    // Clear AsyncStorage record
    await AsyncStorage.removeItem(CACHED_TILES_KEY);

    // Actually delete the cached tile files from the file system
    const dirInfo = await FileSystem.getInfoAsync(TILE_CACHE_DIR);
    if (dirInfo.exists) {
      await FileSystem.deleteAsync(TILE_CACHE_DIR, { idempotent: true });
      console.log('Map tile cache directory deleted');
    }
  } catch (error) {
    console.error('Error clearing cached tiles:', error);
  }
};

// Format speed with unit preference
export const formatSpeed = (kmh, unit = 'miles') => {
  if (!kmh || kmh < 0) return unit === 'miles' ? '0.0 mph' : '0.0 km/h';
  if (unit === 'miles') {
    return `${(kmh * 0.621371).toFixed(1)} mph`;
  }
  return `${kmh.toFixed(1)} km/h`;
};

// Format pace with unit preference
export const formatPace = (kmh, unit = 'miles') => {
  if (!kmh || kmh <= 0) return '--:--';
  if (unit === 'miles') {
    const paceMinutes = 60 / (kmh * 0.621371); // min per mile
    const mins = Math.floor(paceMinutes);
    const secs = Math.round((paceMinutes - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /mi`;
  } else {
    const paceMinutes = 60 / kmh; // min per km
    const mins = Math.floor(paceMinutes);
    const secs = Math.round((paceMinutes - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, '0')} /km`;
  }
};

// Format elevation - always in metres regardless of distance unit preference
export const formatElevation = (meters, unit = 'miles') => {
  if (meters === undefined || meters === null) return '0 m';
  return `${Math.round(meters)} m`;
};

/**
 * Auto-export a single activity as GPX to an external location (Download folder via MediaStore).
 * This is called automatically after each activity is saved to ensure a user-accessible backup.
 * Uses the app's persistent SAF permission if already granted, otherwise writes to
 * the app's Downloads-like directory and logs the location.
 */
export const autoExportActivityGPX = async (activity) => {
  try {
    const { activityToGPX } = await import('./fileStorage');

    const routeData = activity.routeData || activity.route || [];
    if (routeData.length === 0) {
      console.log('autoExportActivityGPX: no route data, skipping');
      return { success: false, reason: 'no_route_data' };
    }

    const activityWithRoute = { ...activity, routeData };
    const gpxContent = activityToGPX(activityWithRoute);
    const fileName = `TrailTracker_${activity.id}.gpx`;

    // Use SAF to write directly to a user-accessible location
    // We use the Documents directory for the 'TrailTrackerXP' folder
    // (visible in any file explorer under Android/data is restricted,
    //  but we write via SAF to a persistent permission if available)

    // Check if we have a stored export directory URI from a previous export
    const AsyncStorageLib = (await import('@react-native-async-storage/async-storage')).default;
    const savedDirUri = await AsyncStorageLib.getItem('@trail_tracker_auto_export_dir');

    if (savedDirUri) {
      try {
        const newFileUri = await FileSystem.StorageAccessFramework.createFileAsync(
          savedDirUri,
          fileName,
          'application/gpx+xml'
        );
        await FileSystem.writeAsStringAsync(newFileUri, gpxContent);
        console.log(`Auto-exported GPX to external storage: ${fileName}`);
        return { success: true, uri: newFileUri };
      } catch (e) {
        // Saved URI may have become stale - clear it
        console.log('Auto-export with saved URI failed, clearing saved dir:', e.message);
        await AsyncStorageLib.removeItem('@trail_tracker_auto_export_dir');
      }
    }

    // No stored dir - silently save to internal for now; user can set export dir in settings
    console.log('Auto-export: no external dir configured. Activity saved to internal GPX storage only.');
    return { success: false, reason: 'no_external_dir_configured' };

  } catch (error) {
    console.log('autoExportActivityGPX error:', error.message);
    return { success: false, error: error.message };
  }
};
