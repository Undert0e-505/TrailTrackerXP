/**
 * GPX File-based storage for TrailTrackerXP activities
 * 
 * This module provides persistent file storage for activity data using GPX format,
 * making it compatible with Strava and other fitness apps.
 * 
 * Data is stored in the app's document directory which persists across app updates
 * and can only be cleared by uninstalling the app or manually clearing app data.
 * 
 * File Structure:
 * - /activities/{id}.gpx - Individual activity files in GPX format
 * - /activities/gamification.json - Gamification data (separate from activities)
 * - /export/trailtrackerxp_export_{date}.json - Full export files (legacy format for backup)
 */

import * as FileSystem from 'expo-file-system';
import {
  ACTIVITY_TYPES,
  IMPORT_TYPE_MAP,
  fromImportedActivityType,
  getDefaultActivityName,
  toGPXActivityType,
} from './activityTypes';

// File paths
const ACTIVITIES_DIR = `${FileSystem.documentDirectory}activities/`;
const EXPORT_DIR = `${FileSystem.documentDirectory}export/`;
const GAMIFICATION_FILE = `${ACTIVITIES_DIR}gamification.json`;

// TrailTrackerXP activity types mapping to GPX types
export const INTERNAL_TO_GPX_TYPE = Object.fromEntries(
  ACTIVITY_TYPES.map(type => [type.id, type.gpxType])
);
export const GPX_TO_INTERNAL_TYPE = IMPORT_TYPE_MAP;

/**
 * Initialize the file storage directories
 */
export const initFileStorage = async () => {
  try {
    // Create directories if they don't exist
    const activitiesDirInfo = await FileSystem.getInfoAsync(ACTIVITIES_DIR);
    if (!activitiesDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(ACTIVITIES_DIR, { intermediates: true });
      console.log('Created activities directory');
    }

    const exportDirInfo = await FileSystem.getInfoAsync(EXPORT_DIR);
    if (!exportDirInfo.exists) {
      await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
      console.log('Created export directory');
    }

    return true;
  } catch (error) {
    console.error('Error initializing file storage:', error);
    return false;
  }
};

/**
 * Convert activity to GPX format string
 * Matches the Strava GPX format exactly
 */
export const activityToGPX = (activity) => {
  const routeData = activity.routeData || activity.route || [];
  
  // Determine the name
  const name = activity.name ||
    `${getDefaultActivityName(activity.type)} - ${new Date(activity.timestamp).toLocaleDateString()}`;
  
  // Determine GPX type
  const gpxType = toGPXActivityType(activity.type);
  
  // Get metadata time from first point or activity timestamp
  const metadataTime = routeData.length > 0 
    ? new Date(routeData[0].timestamp).toISOString()
    : activity.timestamp || new Date().toISOString();
  
  // Build trackpoints
  let trackpoints = '';
  for (const point of routeData) {
    const lat = point.latitude.toFixed(7);
    const lon = point.longitude.toFixed(7);
    const ele = (point.altitude || 0).toFixed(1);
    const time = new Date(point.timestamp).toISOString();
    
    trackpoints += `   <trkpt lat="${lat}" lon="${lon}">
    <ele>${ele}</ele>
    <time>${time}</time>
   </trkpt>\n`;
  }
  
  // Build the GPX document (matching Strava/sample format)
  // Note: Using <n> tag for name as seen in Strava exports
  // Include activity id in <desc> for dedup detection on re-import
  const descTag = activity.id
    ? `  <desc>TrailTrackerXP activity id: ${escapeXML(activity.id)}</desc>\n`
    : '';
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="TrailTrackerXP" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
 <metadata>
  <time>${metadataTime}</time>
${descTag} </metadata>
 <trk>
  <name>${escapeXML(name)}</name>
  <type>${gpxType}</type>
  <trkseg>
${trackpoints}  </trkseg>
 </trk>
</gpx>
`;
  
  return gpx;
};

/**
 * Escape XML special characters
 */
const escapeXML = (str) => {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

/**
 * Parse GPX file content into activity data
 */
export const parseGPX = (gpxContent) => {
  const routeData = [];
  
  try {
    // Extract activity name - try both <n> and <name> tags (Strava uses <n> sometimes)
    let name = null;
    const nameMatch = gpxContent.match(/<name>([^<]+)<\/name>/);
    if (nameMatch) {
      name = nameMatch[1];
    } else {
      const nMatch = gpxContent.match(/<n>([^<]+)<\/n>/);
      if (nMatch) name = nMatch[1];
    }
    
    // Extract activity type from GPX
    const typeMatch = gpxContent.match(/<type>([^<]+)<\/type>/);
    const gpxType = typeMatch ? typeMatch[1] : null;
    
    // Extract metadata time
    const metaTimeMatch = gpxContent.match(/<metadata>\s*<time>([^<]+)<\/time>/);
    const metadataTime = metaTimeMatch ? metaTimeMatch[1] : null;
    
    // Extract all track points
    const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>\s*(?:<ele>([^<]*)<\/ele>)?\s*(?:<time>([^<]*)<\/time>)?/g;
    
    let match;
    let cumulativeDistance = 0;
    let prevLat = null;
    let prevLon = null;
    
    while ((match = trkptRegex.exec(gpxContent)) !== null) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      const ele = match[3] ? parseFloat(match[3]) : 0;
      const time = match[4] ? new Date(match[4]).getTime() : Date.now();
      
      // Calculate cumulative distance
      if (prevLat !== null && prevLon !== null) {
        cumulativeDistance += haversineDistance(prevLat, prevLon, lat, lon);
      }
      
      routeData.push({
        latitude: lat,
        longitude: lon,
        altitude: ele,
        timestamp: time,
        cumulativeDistance: cumulativeDistance,
      });
      
      prevLat = lat;
      prevLon = lon;
    }
    
    return {
      name,
      type: gpxType,
      metadataTime,
      routeData,
    };
  } catch (error) {
    console.error('Error parsing GPX:', error);
    return { routeData: [], name: null, type: null };
  }
};

/**
 * Haversine distance calculation (returns km)
 */
const haversineDistance = (lat1, lon1, lat2, lon2) => {
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

/**
 * Get list of all saved GPX activity IDs
 */
export const getSavedActivityIds = async () => {
  const _t0 = Date.now();
  try {
    await initFileStorage();
    
    const files = await FileSystem.readDirectoryAsync(ACTIVITIES_DIR);
    const gpxFiles = files.filter(f => f.endsWith('.gpx'));
    
    console.log(`[SAVE_TIMING] getSavedActivityIds: ${Date.now() - _t0}ms (${gpxFiles.length} files)`);
    // Extract IDs from filenames (remove .gpx extension)
    return gpxFiles.map(f => f.replace('.gpx', ''));
  } catch (error) {
    console.error('Error getting saved activity IDs:', error);
    console.log(`[SAVE_TIMING] getSavedActivityIds: ${Date.now() - _t0}ms (ERROR)`);
    return [];
  }
};

/**
 * Check if an activity is already saved as GPX
 */
export const isActivitySaved = async (activityId) => {
  try {
    const gpxFile = `${ACTIVITIES_DIR}${activityId}.gpx`;
    const fileInfo = await FileSystem.getInfoAsync(gpxFile);
    return fileInfo.exists;
  } catch (error) {
    console.error('Error checking if activity saved:', error);
    return false;
  }
};

/**
 * Save an activity to file storage as GPX
 */
export const saveActivityToFile = async (activity) => {
  const _t0 = Date.now();
  await initFileStorage();
  
  // Get the route data - it might be stored as 'route' or 'routeData'
  const routeData = activity.routeData || activity.route || [];
  
  // Only save if there's route data
  if (routeData.length === 0) {
    console.log(`Activity ${activity.id} has no route data, skipping GPX save`);
    return false;
  }
  
  // Create activity object with routeData properly set
  const activityWithRoute = {
    ...activity,
    routeData: routeData,
  };
  
  // Convert to GPX format
  const _t1 = Date.now();
  const gpxContent = activityToGPX(activityWithRoute);
  console.log(`[SAVE_TIMING] saveActivityToFile.activityToGPX: ${Date.now() - _t1}ms (${routeData.length} points, ${gpxContent.length} chars)`);
  
  // Save to file
  const _t2 = Date.now();
  const gpxFile = `${ACTIVITIES_DIR}${activity.id}.gpx`;
  await FileSystem.writeAsStringAsync(gpxFile, gpxContent);
  console.log(`[SAVE_TIMING] saveActivityToFile.writeAsString: ${Date.now() - _t2}ms`);
  
  console.log(`[SAVE_TIMING] saveActivityToFile.total: ${Date.now() - _t0}ms`);
  console.log(`Activity ${activity.id} saved as GPX`);
  return true;
};

/**
 * Load an activity from GPX file
 */
export const loadActivityFromFile = async (activityId) => {
  try {
    const gpxFile = `${ACTIVITIES_DIR}${activityId}.gpx`;
    const fileInfo = await FileSystem.getInfoAsync(gpxFile);
    
    if (!fileInfo.exists) {
      return null;
    }
    
    const gpxContent = await FileSystem.readAsStringAsync(gpxFile);
    const parsed = parseGPX(gpxContent);
    
    if (parsed.routeData.length === 0) {
      return null;
    }
    
    // Calculate stats from route data
    const startTime = parsed.routeData[0].timestamp;
    const endTime = parsed.routeData[parsed.routeData.length - 1].timestamp;
    const duration = (endTime - startTime) / 1000; // seconds
    const distance = parsed.routeData[parsed.routeData.length - 1].cumulativeDistance;
    
    // Calculate elevation
    let elevGain = 0;
    let elevLoss = 0;
    let minAlt = Infinity;
    let maxAlt = -Infinity;
    
    for (let i = 1; i < parsed.routeData.length; i++) {
      const diff = parsed.routeData[i].altitude - parsed.routeData[i-1].altitude;
      if (diff > 0) elevGain += diff;
      else elevLoss += Math.abs(diff);
      
      minAlt = Math.min(minAlt, parsed.routeData[i].altitude);
      maxAlt = Math.max(maxAlt, parsed.routeData[i].altitude);
    }
    if (parsed.routeData.length > 0) {
      minAlt = Math.min(minAlt, parsed.routeData[0].altitude);
      maxAlt = Math.max(maxAlt, parsed.routeData[0].altitude);
    }
    
    // Determine activity type
    const type = fromImportedActivityType(parsed.type, 'walking');
    
    // Create activity object
    const activity = {
      id: activityId,
      timestamp: parsed.metadataTime || new Date(startTime).toISOString(),
      name: parsed.name || getDefaultActivityName(type, true),
      type: type,
      distance: distance,
      duration: duration,
      movingTime: duration, // We don't have moving time in GPX, use total duration
      elevationGain: elevGain,
      elevationLoss: elevLoss,
      maxAltitude: maxAlt !== -Infinity ? maxAlt : null,
      minAltitude: minAlt !== Infinity ? minAlt : null,
      avgSpeed: duration > 0 ? (distance / (duration / 3600)) : 0,
      maxSpeed: null,
      routeData: parsed.routeData,
      route: parsed.routeData, // Include both for compatibility
    };
    
    return activity;
  } catch (error) {
    console.error('Error loading activity from GPX:', error);
    return null;
  }
};

/**
 * Load all activities from GPX files in file storage
 */
export const loadActivitiesFromFile = async () => {
  try {
    await initFileStorage();
    
    const activityIds = await getSavedActivityIds();
    const activities = [];
    
    for (const id of activityIds) {
      const activity = await loadActivityFromFile(id);
      if (activity) {
        activities.push(activity);
      }
    }
    
    // Sort by timestamp (newest first)
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    return activities;
  } catch (error) {
    console.error('Error loading activities from file:', error);
    return [];
  }
};

/**
 * Load just the route data from a GPX file (lightweight, for thumbnails)
 * Returns the route array or null if not found
 */
export const loadRouteFromFile = async (activityId) => {
  try {
    const gpxFile = `${ACTIVITIES_DIR}${activityId}.gpx`;
    const fileInfo = await FileSystem.getInfoAsync(gpxFile);
    
    if (!fileInfo.exists) {
      return null;
    }
    
    const gpxContent = await FileSystem.readAsStringAsync(gpxFile);
    const parsed = parseGPX(gpxContent);
    
    if (parsed.routeData.length === 0) {
      return null;
    }
    
    return parsed.routeData;
  } catch (error) {
    console.error('Error loading route from GPX:', error);
    return null;
  }
};

/**
 * Enrich activities with route data from GPX files
 * For activities that don't have route data in memory, load it from file
 */
export const enrichActivitiesWithRoutes = async (activities) => {
  const enriched = [];
  
  for (const activity of activities) {
    // If activity already has route data, use it
    if (activity.route && activity.route.length > 0) {
      enriched.push(activity);
      continue;
    }
    if (activity.routeData && activity.routeData.length > 0) {
      enriched.push({ ...activity, route: activity.routeData });
      continue;
    }
    
    // Try to load route from GPX file
    const route = await loadRouteFromFile(activity.id);
    if (route) {
      enriched.push({ ...activity, route });
    } else {
      enriched.push(activity);
    }
  }
  
  return enriched;
};

/**
 * Delete an activity from file storage
 */
export const deleteActivityFromFile = async (activityId) => {
  try {
    const gpxFile = `${ACTIVITIES_DIR}${activityId}.gpx`;
    const fileInfo = await FileSystem.getInfoAsync(gpxFile);
    
    if (fileInfo.exists) {
      await FileSystem.deleteAsync(gpxFile);
      console.log(`Activity ${activityId} GPX file deleted`);
    }
    
    return true;
  } catch (error) {
    console.error('Error deleting activity GPX:', error);
    return false;
  }
};

/**
 * Save gamification data to file storage
 */
export const saveGamificationToFile = async (gamificationData) => {
  try {
    await initFileStorage();
    
    await FileSystem.writeAsStringAsync(
      GAMIFICATION_FILE,
      JSON.stringify(gamificationData, null, 2)
    );
    
    return true;
  } catch (error) {
    console.error('Error saving gamification to file:', error);
    return false;
  }
};

/**
 * Load gamification data from file storage
 */
export const loadGamificationFromFile = async () => {
  try {
    await initFileStorage();
    
    const fileInfo = await FileSystem.getInfoAsync(GAMIFICATION_FILE);
    if (!fileInfo.exists) {
      return null;
    }
    
    const content = await FileSystem.readAsStringAsync(GAMIFICATION_FILE);
    return JSON.parse(content);
  } catch (error) {
    console.error('Error loading gamification from file:', error);
    return null;
  }
};

/**
 * Export activities from cache to file storage as GPX files
 * Only saves activities that don't already exist as GPX files
 */
export const exportCacheToFileStorage = async (cacheActivities, gamificationData) => {
  try {
    await initFileStorage();
    
    let exportedCount = 0;
    let skippedCount = 0;
    let noRouteCount = 0;
    
    // Get existing GPX file IDs
    const existingIds = new Set(await getSavedActivityIds());
    
    for (const activity of cacheActivities) {
      const activityId = activity.id?.toString();
      
      // Skip if already saved as GPX
      if (existingIds.has(activityId)) {
        skippedCount++;
        continue;
      }
      
      // Check if activity has route data
      const routeData = activity.routeData || activity.route || [];
      if (routeData.length === 0) {
        noRouteCount++;
        continue;
      }
      
      // Save as GPX
      const saved = await saveActivityToFile(activity);
      if (saved) {
        exportedCount++;
      }
    }
    
    // Save gamification data to file
    if (gamificationData) {
      await saveGamificationToFile(gamificationData);
    }
    
    console.log(`Export complete: ${exportedCount} new GPX files, ${skippedCount} already exist, ${noRouteCount} have no route data`);
    
    return {
      success: true,
      exportedCount,
      skippedCount,
      noRouteCount,
      totalInFile: existingIds.size + exportedCount,
    };
  } catch (error) {
    console.error('Error exporting cache to file storage:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Recover activities from GPX file storage to cache
 * Use this when cache data is lost/corrupted
 */
export const recoverFromFileStorage = async () => {
  try {
    const activities = await loadActivitiesFromFile();
    
    console.log(`Recovered ${activities.length} activities from GPX file storage`);
    
    return {
      success: true,
      activities: activities,
      count: activities.length,
    };
  } catch (error) {
    console.error('Error recovering from file storage:', error);
    return {
      success: false,
      error: error.message,
      activities: [],
    };
  }
};

/**
 * Get storage statistics
 */
export const getStorageStats = async () => {
  try {
    await initFileStorage();
    
    const files = await FileSystem.readDirectoryAsync(ACTIVITIES_DIR);
    const gpxFiles = files.filter(f => f.endsWith('.gpx'));
    
    let totalSize = 0;
    
    for (const file of gpxFiles) {
      const info = await FileSystem.getInfoAsync(`${ACTIVITIES_DIR}${file}`);
      totalSize += info.size || 0;
    }
    
    // Check gamification file
    const gamInfo = await FileSystem.getInfoAsync(GAMIFICATION_FILE);
    const gamSize = gamInfo.exists ? (gamInfo.size || 0) : 0;
    
    return {
      activityCount: gpxFiles.length,
      gpxFileCount: gpxFiles.length,
      gpxSizeBytes: totalSize,
      gamificationSizeBytes: gamSize,
      totalSizeBytes: totalSize + gamSize,
    };
  } catch (error) {
    console.error('Error getting storage stats:', error);
    return {
      activityCount: 0,
      error: error.message,
    };
  }
};

/**
 * Verify data integrity between cache and file storage
 */
export const verifyDataIntegrity = async (cacheActivities) => {
  try {
    const savedIds = new Set(await getSavedActivityIds());
    const cacheIds = new Set(cacheActivities.map(a => a.id?.toString()));
    
    const inCacheOnly = cacheActivities.filter(a => !savedIds.has(a.id?.toString()));
    const inFileOnly = [...savedIds].filter(id => !cacheIds.has(id));
    const inBoth = cacheActivities.filter(a => savedIds.has(a.id?.toString()));
    
    // Check how many cache-only activities have route data
    const cacheOnlyWithRoute = inCacheOnly.filter(a => {
      const routeData = a.routeData || a.route || [];
      return routeData.length > 0;
    });
    
    return {
      cacheCount: cacheActivities.length,
      fileCount: savedIds.size,
      inCacheOnly: inCacheOnly.length,
      inCacheOnlyWithRoute: cacheOnlyWithRoute.length,
      inFileOnly: inFileOnly.length,
      synchronized: inBoth.length,
      needsSync: cacheOnlyWithRoute.length > 0,
      activitiesInCacheOnly: inCacheOnly,
      activitiesInFileOnly: inFileOnly,
    };
  } catch (error) {
    console.error('Error verifying data integrity:', error);
    return {
      error: error.message,
    };
  }
};

/**
 * Sync all cache activities to file storage
 */
export const syncCacheToFile = async (cacheActivities) => {
  try {
    const integrity = await verifyDataIntegrity(cacheActivities);
    
    if (integrity.needsSync) {
      console.log(`Syncing ${integrity.inCacheOnlyWithRoute} activities from cache to GPX files...`);
      
      for (const activity of integrity.activitiesInCacheOnly) {
        const routeData = activity.routeData || activity.route || [];
        if (routeData.length > 0) {
          await saveActivityToFile(activity);
        }
      }
      
      console.log('Sync complete');
    }
    
    return {
      synced: integrity.inCacheOnlyWithRoute,
      totalInFile: integrity.fileCount + integrity.inCacheOnlyWithRoute,
    };
  } catch (error) {
    console.error('Error syncing cache to file:', error);
    return { error: error.message };
  }
};

/**
 * Create a full export file (JSON format for backup compatibility)
 * Includes all activity data from GPX files
 */
export const createFullExport = async () => {
  try {
    await initFileStorage();
    
    // Load all activities from GPX files
    const activities = await loadActivitiesFromFile();
    
    // Load gamification data
    const gamificationData = await loadGamificationFromFile();
    
    // Create export object
    const exportData = {
      version: 2,
      app: 'TrailTrackerXP',
      format: 'gpx-based',
      exported_at: new Date().toISOString(),
      activities: activities.map(a => ({
        ...a,
        // Subsample route data if very large to reduce file size
        routeData: a.routeData && a.routeData.length > 500 
          ? a.routeData.filter((_, idx) => idx % 5 === 0)
          : a.routeData,
      })),
      gamification: gamificationData,
    };
    
    // Write export file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportFile = `${EXPORT_DIR}trailtrackerxp_export_${timestamp}.json`;
    
    const jsonString = JSON.stringify(exportData, null, 2);
    await FileSystem.writeAsStringAsync(exportFile, jsonString);
    
    return {
      success: true,
      filePath: exportFile,
      activityCount: activities.length,
    };
  } catch (error) {
    console.error('Error creating full export:', error);
    
    if (error.message && error.message.includes('OutOfMemoryError')) {
      return {
        success: false,
        error: 'Not enough memory to create backup. Try clearing some app data first.',
      };
    }
    
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Export all GPX files to a shareable location
 * Copies GPX files to a zip-friendly export directory and returns the path
 */
export const exportGPXFiles = async () => {
  try {
    await initFileStorage();
    
    // Get all GPX files
    const files = await FileSystem.readDirectoryAsync(ACTIVITIES_DIR);
    const gpxFiles = files.filter(f => f.endsWith('.gpx'));
    
    if (gpxFiles.length === 0) {
      return {
        success: false,
        error: 'No GPX files to export',
        count: 0,
      };
    }
    
    // Create export directory with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportSubDir = `${EXPORT_DIR}gpx_export_${timestamp}/`;
    
    await FileSystem.makeDirectoryAsync(exportSubDir, { intermediates: true });
    
    // Copy all GPX files to export directory
    let copiedCount = 0;
    const exportedFiles = [];
    
    for (const file of gpxFiles) {
      try {
        const sourcePath = `${ACTIVITIES_DIR}${file}`;
        const destPath = `${exportSubDir}${file}`;
        await FileSystem.copyAsync({ from: sourcePath, to: destPath });
        exportedFiles.push(destPath);
        copiedCount++;
      } catch (err) {
        console.error(`Error copying ${file}:`, err);
      }
    }
    
    // Also copy gamification data as JSON
    const gamInfo = await FileSystem.getInfoAsync(GAMIFICATION_FILE);
    if (gamInfo.exists) {
      await FileSystem.copyAsync({ 
        from: GAMIFICATION_FILE, 
        to: `${exportSubDir}gamification.json` 
      });
    }
    
    return {
      success: true,
      exportDir: exportSubDir,
      count: copiedCount,
      files: exportedFiles,
    };
  } catch (error) {
    console.error('Error exporting GPX files:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Get a single GPX file path for sharing
 */
export const getGPXFilePath = async (activityId) => {
  const gpxFile = `${ACTIVITIES_DIR}${activityId}.gpx`;
  const fileInfo = await FileSystem.getInfoAsync(gpxFile);
  
  if (fileInfo.exists) {
    return gpxFile;
  }
  return null;
};

/**
 * Get all GPX file paths for sharing
 */
export const getAllGPXFilePaths = async () => {
  try {
    await initFileStorage();
    
    const files = await FileSystem.readDirectoryAsync(ACTIVITIES_DIR);
    const gpxFiles = files.filter(f => f.endsWith('.gpx'));
    
    return gpxFiles.map(f => `${ACTIVITIES_DIR}${f}`);
  } catch (error) {
    console.error('Error getting GPX file paths:', error);
    return [];
  }
};

// Legacy compatibility exports (deprecated, use GPX functions instead)
export const toStravaFormat = (activity) => activity;
export const fromStravaFormat = (activity) => activity;
export const toStravaStreams = (routeData) => ({ routeData });
export const fromStravaStreams = (streams, startTimestamp) => streams?.routeData || [];
export const loadActivityWithStreams = loadActivityFromFile;
