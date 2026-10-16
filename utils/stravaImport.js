/**
 * Strava/GPX Import for TrailTrackerXP
 * 
 * This module imports activities from Strava export files.
 * Users can select GPX files directly using a file picker.
 * 
 * Strava Export Structure:
 * - activities.csv - Metadata for all activities (type, distance, elevation, etc.)
 * - activities/*.gpx - GPS track data for each activity
 */

import * as FileSystem from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveActivityToFile, saveGamificationToFile, loadActivitiesFromFile } from './fileStorage';
import { recalculateGamification } from './gamification';
import { fromImportedActivityType, getDefaultActivityName } from './activityTypes';

const ACTIVITIES_KEY = '@trail_tracker_activities';

/**
 * Open file picker to select GPX files
 * Note: On Android, we use StorageAccessFramework to pick a directory
 * Returns array of selected file URIs
 */
export const pickGPXFiles = async () => {
  try {
    // Request directory access permission
    const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    
    if (!permissions.granted) {
      return { canceled: true, files: [] };
    }
    
    // Read all files in the selected directory
    const directoryUri = permissions.directoryUri;
    console.log('Directory URI:', directoryUri);
    
    const files = await FileSystem.StorageAccessFramework.readDirectoryAsync(directoryUri);
    console.log('Total files returned by SAF:', files.length);
    
    // Log first few URIs to debug format
    if (files.length > 0) {
      console.log('Sample URIs:');
      files.slice(0, 3).forEach((uri, i) => console.log(`  ${i}: ${uri.substring(0, 100)}...`));
    }
    
    // Filter to only GPX files and create file objects
    const gpxFiles = [];
    const nonGpxFiles = [];
    
    for (const fileUri of files) {
      // Extract filename from SAF URI
      // URIs can be double-encoded, so decode until stable
      let decoded = fileUri;
      let prev = '';
      while (decoded !== prev && decoded.includes('%')) {
        prev = decoded;
        try {
          decoded = decodeURIComponent(decoded);
        } catch (e) {
          break; // Stop if decoding fails (invalid encoding)
        }
      }
      
      // SAF URIs often have the filename after the last colon or slash
      // e.g., "content://.../document/primary:Download/strava/12345.gpx"
      let fileName = decoded.split('/').pop();
      // Also check for colon-separated paths (common in SAF)
      if (fileName.includes(':')) {
        fileName = fileName.split(':').pop();
      }
      
      if (fileName.toLowerCase().endsWith('.gpx')) {
        gpxFiles.push({
          uri: fileUri,
          name: fileName,
        });
      } else {
        nonGpxFiles.push(fileName);
      }
    }
    
    console.log(`GPX files found: ${gpxFiles.length}, non-GPX files: ${nonGpxFiles.length}`);
    if (nonGpxFiles.length > 0 && nonGpxFiles.length <= 10) {
      console.log('Non-GPX files:', nonGpxFiles);
    }

    return {
      canceled: false,
      files: gpxFiles,
      totalSelected: files.length,
      gpxCount: gpxFiles.length,
      directoryUri: directoryUri,
    };
  } catch (error) {
    console.error('Error picking files:', error);
    return { canceled: false, files: [], error: error.message };
  }
};

/**
 * Open file picker to select activities.csv (optional metadata)
 */
export const pickActivitiesCSV = async () => {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',  // Allow all files
      multiple: false,
      copyToCacheDirectory: true,
    });

    if (result.canceled) {
      return { canceled: true, file: null };
    }

    const file = result.assets[0];
    if (!file.name.toLowerCase().endsWith('.csv')) {
      return { canceled: false, file: null, error: 'Please select a CSV file' };
    }

    return { canceled: false, file };
  } catch (error) {
    console.error('Error picking CSV:', error);
    return { canceled: false, file: null, error: error.message };
  }
};

/**
 * Parse GPX file content into route data
 */
export const parseGPX = (gpxContent) => {
  const routeData = [];
  
  try {
    // Extract activity name - try both <name> and <n> tags
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
 * Parse activities.csv from Strava export
 */
export const parseActivitiesCSV = async (csvUri) => {
  try {
    // For SAF URIs, we need to use StorageAccessFramework to read
    let content;
    if (csvUri.startsWith('content://')) {
      content = await FileSystem.StorageAccessFramework.readAsStringAsync(csvUri);
    } else {
      content = await FileSystem.readAsStringAsync(csvUri);
    }
    const lines = content.split('\n');
    
    if (lines.length < 2) return {};
    
    // Parse header
    const header = parseCSVLine(lines[0]);
    const idIndex = header.indexOf('Activity ID');
    const dateIndex = header.indexOf('Activity Date');
    const nameIndex = header.indexOf('Activity Name');
    const typeIndex = header.indexOf('Activity Type');
    const filenameIndex = header.indexOf('Filename');
    
    // Find distance - there are two "Distance" columns, use the one with values (index ~17)
    let distanceIndex = -1;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === 'Distance' && i > 10) {
        distanceIndex = i;
        break;
      }
    }
    
    // Similarly for Moving Time and Elapsed Time
    let movingTimeIndex = -1;
    let elapsedTimeIndex = -1;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === 'Moving Time' && i > 10) movingTimeIndex = i;
      if (header[i] === 'Elapsed Time' && i > 10) elapsedTimeIndex = i;
    }
    
    const elevGainIndex = header.indexOf('Elevation Gain');
    const elevLossIndex = header.indexOf('Elevation Loss');
    const maxSpeedIndex = header.indexOf('Max Speed');
    const avgSpeedIndex = header.indexOf('Average Speed');
    
    const metadata = {};
    
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      
      const values = parseCSVLine(lines[i]);
      
      const activityId = values[idIndex];
      const filename = values[filenameIndex];
      
      if (!activityId || !filename) continue;
      
      // Extract just the filename from path like "activities/12345.gpx"
      const gpxFilename = filename.split('/').pop();
      
      // Parse date - format: "7 May 2017, 09:59:01"
      const dateStr = values[dateIndex];
      let timestamp;
      try {
        timestamp = parseStravaDate(dateStr);
      } catch (e) {
        timestamp = new Date().toISOString();
      }
      
      const activityType = values[typeIndex] || 'Ride';
      
      metadata[gpxFilename] = {
        stravaId: activityId,
        filename: gpxFilename,
        name: values[nameIndex] || `${activityType} Activity`,
        type: fromImportedActivityType(activityType, 'walking'),
        stravaType: activityType,
        timestamp: timestamp,
        distance: parseFloat(values[distanceIndex]) / 1000 || 0, // Convert m to km
        duration: parseFloat(values[elapsedTimeIndex]) || 0,
        movingTime: parseFloat(values[movingTimeIndex]) || 0,
        elevationGain: parseFloat(values[elevGainIndex]) || 0,
        elevationLoss: parseFloat(values[elevLossIndex]) || 0,
        maxSpeed: parseFloat(values[maxSpeedIndex]) * 3.6 || 0, // m/s to km/h
        avgSpeed: parseFloat(values[avgSpeedIndex]) * 3.6 || 0, // m/s to km/h
      };
    }
    
    return metadata;
  } catch (error) {
    console.error('Error parsing activities.csv:', error);
    return {};
  }
};

/**
 * Parse a CSV line handling quoted fields
 */
const parseCSVLine = (line) => {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  
  return values;
};

/**
 * Parse Strava date format: "7 May 2017, 09:59:01"
 */
const parseStravaDate = (dateStr) => {
  if (!dateStr) return new Date().toISOString();
  
  // Remove quotes if present
  dateStr = dateStr.replace(/"/g, '').trim();
  
  // Parse "7 May 2017, 09:59:01" format
  // Note: Strava uses 'Sept' for September, not 'Sep'
  const months = {
    'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
    'Jul': 6, 'Aug': 7, 'Sep': 8, 'Sept': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
  };
  
  const match = dateStr.match(/(\d+)\s+(\w+)\s+(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (match) {
    const [_, day, month, year, hour, min, sec] = match;
    const monthNum = months[month];
    if (monthNum === undefined) {
      console.warn(`Unknown month: ${month} in date: ${dateStr}`);
    }
    const date = new Date(
      parseInt(year),
      monthNum ?? 0,
      parseInt(day),
      parseInt(hour),
      parseInt(min),
      parseInt(sec)
    );
    return date.toISOString();
  }
  
  // Fallback - try standard parsing
  return new Date(dateStr).toISOString();
};

/**
 * Import a single GPX file from a picked file
 */
export const importGPXFromUri = async (fileUri, fileName, metadata = null) => {
  try {
    // For SAF URIs, we need to use StorageAccessFramework to read
    let gpxContent;
    if (fileUri.startsWith('content://')) {
      gpxContent = await FileSystem.StorageAccessFramework.readAsStringAsync(fileUri);
    } else {
      gpxContent = await FileSystem.readAsStringAsync(fileUri);
    }
    
    const parsed = parseGPX(gpxContent);
    
    if (parsed.routeData.length === 0) {
      return { success: false, error: 'No track points found in GPX' };
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
    
    // Determine activity type
    let type = 'walking';
    if (parsed.type) {
      type = fromImportedActivityType(parsed.type, 'walking');
    } else if (metadata?.type) {
      type = metadata.type;
    }
    
    // Create activity object
    const activity = {
      id: metadata?.stravaId || fileName.replace('.gpx', '') || Date.now().toString(),
      timestamp: metadata?.timestamp || new Date(startTime).toISOString(),
      name: metadata?.name || parsed.name || getDefaultActivityName(type, true),
      type: type,
      distance: metadata?.distance || distance,
      duration: metadata?.duration || duration,
      movingTime: metadata?.movingTime || duration,
      elevationGain: metadata?.elevationGain || elevGain,
      elevationLoss: metadata?.elevationLoss || elevLoss,
      maxAltitude: maxAlt !== -Infinity ? maxAlt : null,
      minAltitude: minAlt !== Infinity ? minAlt : null,
      avgSpeed: metadata?.avgSpeed || (distance / (duration / 3600)),
      maxSpeed: metadata?.maxSpeed || null,
      routeData: parsed.routeData,
      importedFrom: 'strava',
      stravaId: metadata?.stravaId || null,
    };
    
    // Save to file storage
    await saveActivityToFile(activity);
    
    return { success: true, activity };
  } catch (error) {
    console.error(`Error importing ${fileName}:`, error);
    return { success: false, error: error.message };
  }
};

/**
 * Scan a user-selected GPX folder for duplicates and optionally delete them.
 *
 * @param {string} directoryUri - SAF URI for the selected folder
 * @param {Function} onProgress - callback(current, total, fileName)
 * @returns {Object} scan result with groups for deletion
 */
export const scanGPXFolderForDuplicates = async (directoryUri, onProgress = null) => {
  const { signatureFromGPXContent, groupDuplicates, normaliseDuplicateFilename } = require('./gpxIdentity');

  // Phase 1: Raw folder enumeration — count EVERYTHING before any filtering
  const allEntries = await FileSystem.StorageAccessFramework.readDirectoryAsync(directoryUri);
  const totalEntries = allEntries.length;

  // Classify files: GPX files, GPX-like duplicate-name files, and other
  // Android puts copy suffixes AFTER the extension: "route.gpx (1)", "route.gpx - copy"
  const gpxFiles = [];
  let gpxDuplicateNameCount = 0;
  let otherNonGpxCount = 0;

  // A file is GPX-like if it ends with .gpx OR has .gpx followed by a copy/duplicate suffix
  const gpxLikePattern = /\.gpx(\s*\(\d+\)|\s*-\s*copy|\s+copy|\s*-\s*duplicate|\s+duplicate|\s*_copy|\s*_duplicate)\s*$/i;

  for (const fileUri of allEntries) {
    // Decode SAF URI to extract filename
    let decoded = fileUri;
    try { decoded = decodeURIComponent(fileUri); } catch (e) {}
    let fileName = decoded.split('/').pop();
    if (fileName.includes(':')) fileName = fileName.split(':').pop();

    const lowerName = fileName.toLowerCase();
    const isPlainGpx = lowerName.endsWith('.gpx');
    const isGpxDuplicateName = gpxLikePattern.test(lowerName);

    if (isPlainGpx || isGpxDuplicateName) {
      gpxFiles.push({ uri: fileUri, name: fileName, isPlainGpx, isGpxDuplicateName });
      if (isGpxDuplicateName && !isPlainGpx) gpxDuplicateNameCount++;
    } else {
      otherNonGpxCount++;
    }
  }

  if (gpxFiles.length === 0) {
    return {
      success: false,
      error: 'No GPX files found in selected folder',
      totalEntries,
      gpxCount: 0,
      gpxDuplicateNameCount: 0,
      otherNonGpxCount,
    };
  }

  // Phase 2: Read content for each GPX-like file (with progress)
  const filesWithContent = [];
  const unparseable = [];
  let firstParseError = null;

  for (let i = 0; i < gpxFiles.length; i++) {
    const f = gpxFiles[i];
    if (onProgress) onProgress(i + 1, gpxFiles.length, f.name);

    try {
      const content = await FileSystem.StorageAccessFramework.readAsStringAsync(f.uri);
      // Diagnostic: log first parse failure in detail
      if (!firstParseError && (!content || content.length === 0)) {
        firstParseError = { name: f.name, byteLength: 0, firstChars: '(empty)', error: 'Empty content from SAF read' };
        console.log(`[folder-scan] Empty read for ${f.name}: uri=${f.uri.substring(0, 80)}`);
      } else if (!firstParseError && !content.includes('<trkpt') && !content.includes('<trk') && !content.includes('<?xml')) {
        firstParseError = { name: f.name, byteLength: content.length, firstChars: content.substring(0, 200), error: 'No GPX/XML structure found' };
        console.log(`[folder-scan] Non-XML content for ${f.name}: length=${content.length}, first 200="${content.substring(0, 200)}"`);
      }
      filesWithContent.push({ ...f, content, contentHash: simpleHash(content), normalisedName: normaliseDuplicateFilename(f.name) });
    } catch (e) {
      console.log(`[folder-scan] Could not read ${f.name}: ${e.message}`);
      if (!firstParseError) {
        firstParseError = { name: f.name, byteLength: 0, firstChars: '(read failed)', error: e.message };
      }
      // Still keep the file for filename-based dedup even if we can't read it
      unparseable.push({ ...f, error: e.message, normalisedName: normaliseDuplicateFilename(f.name) });
    }
  }

  // Phase 3: Group duplicates using multiple signals
  // A. Route signature dedup (for parseable files)
  const { groups: sigGroups, unique: sigUnique, duplicateGroups: sigDupGroups, unparseable: sigUnparseable } = groupDuplicates(filesWithContent);

  // B. Filename-based dedup (for ALL gpx files, including unparseable)
  // Group by normalised filename — files with same normalised name are likely copies
  const filenameGroups = {};
  for (const f of [...filesWithContent, ...unparseable]) {
    const key = f.normalisedName || f.name;
    if (!filenameGroups[key]) filenameGroups[key] = [];
    filenameGroups[key].push(f);
  }

  // C. Content-hash dedup (for parseable files with same hash)
  const hashGroups = {};
  for (const f of filesWithContent) {
    if (!f.contentHash) continue;
    if (!hashGroups[f.contentHash]) hashGroups[f.contentHash] = [];
    hashGroups[f.contentHash].push(f);
  }

  // Build the deletion list
  const filesToDelete = [];
  const deletedUris = new Set();

  // From signature groups (id + routeHash confidence only)
  const safeSigGroups = sigDupGroups.filter(g => g.confidence === 'id' || g.confidence === 'routeHash');
  const fuzzySigGroups = sigDupGroups.filter(g => g.confidence === 'fuzzy');

  for (const group of safeSigGroups) {
    for (const dup of group.duplicates) {
      if (!deletedUris.has(dup.uri)) {
        filesToDelete.push({ uri: dup.uri, name: dup.name, canonicalName: group.canonical.name, reason: `signature:${group.confidence}` });
        deletedUris.add(dup.uri);
      }
    }
  }

  // From filename groups (normalised name matches)
  for (const [normalisedName, files] of Object.entries(filenameGroups)) {
    if (files.length < 2) continue;
    // Pick canonical: prefer non-copy filename, then shortest name, then alphabetical
    const sorted = [...files].sort((a, b) => {
      const aIsCopy = /\(\d+\)|copy|duplicate/i.test(a.name);
      const bIsCopy = /\(\d+\)|copy|duplicate/i.test(b.name);
      if (aIsCopy && !bIsCopy) return 1;
      if (!aIsCopy && bIsCopy) return -1;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name.localeCompare(b.name);
    });
    const canonical = sorted[0];
    for (const dup of sorted.slice(1)) {
      if (!deletedUris.has(dup.uri)) {
        // For filename-based dedup, require either content hash match or both parseable with sig match
        // If we can't read content, only delete if the normalised name is an obvious copy pattern
        const isObviousCopy = /\(\d+\)|\bcopy\b|\bduplicate\b/i.test(dup.name);
        if (isObviousCopy) {
          filesToDelete.push({ uri: dup.uri, name: dup.name, canonicalName: canonical.name, reason: 'filename-copy' });
          deletedUris.add(dup.uri);
        } else if (dup.contentHash && canonical.contentHash && dup.contentHash === canonical.contentHash) {
          filesToDelete.push({ uri: dup.uri, name: dup.name, canonicalName: canonical.name, reason: 'filename+hash' });
          deletedUris.add(dup.uri);
        }
      }
    }
  }

  // From content-hash groups (identical content even if filenames differ)
  for (const [hash, files] of Object.entries(hashGroups)) {
    if (files.length < 2) continue;
    const sorted = [...files].sort((a, b) => {
      const aIsTTP = /TrailTracker/i.test(a.name);
      const bIsTTP = /TrailTracker/i.test(b.name);
      if (aIsTTP && !bIsTTP) return 1;
      if (!aIsTTP && bIsTTP) return -1;
      return a.name.length - b.name.length;
    });
    const canonical = sorted[0];
    for (const dup of sorted.slice(1)) {
      if (!deletedUris.has(dup.uri)) {
        filesToDelete.push({ uri: dup.uri, name: dup.name, canonicalName: canonical.name, reason: 'content-hash' });
        deletedUris.add(dup.uri);
      }
    }
  }

  // Count unique activities (from all parseable files minus duplicates)
  const uniqueCount = sigGroups.length;

  return {
    success: true,
    // Raw enumeration counts
    totalEntries,              // every entry in the folder (files + dirs)
    gpxCount: gpxFiles.length, // every GPX-like file (plain .gpx + .gpx (1) etc)
    gpxPlainCount: gpxFiles.filter(f => f.isPlainGpx).length,
    gpxDuplicateNameCount,    // files like "route.gpx (1)", "route.gpx - copy"
    otherNonGpxCount,          // truly non-GPX files
    // Parse counts
    parseableCount: filesWithContent.length,
    unparseableCount: unparseable.length,
    firstParseError,           // diagnostic: first file that failed to parse
    // Dedup counts
    uniqueCount,               // unique activity signatures
    duplicateFilesCount: filesToDelete.length,
    fuzzyDuplicateGroups: fuzzySigGroups.length,
    fuzzyDuplicateFiles: fuzzySigGroups.reduce((sum, g) => sum + g.duplicates.length, 0),
    // Breakdown by deletion reason
    filenameDuplicates: filesToDelete.filter(f => f.reason.startsWith('filename')).length,
    contentHashDuplicates: filesToDelete.filter(f => f.reason === 'content-hash').length,
    signatureDuplicates: filesToDelete.filter(f => f.reason.startsWith('signature')).length,
    // Deletion targets
    filesToDelete,
    // Diagnostic info
    groups: safeSigGroups.map(g => ({
      canonical: g.canonical.name,
      duplicates: g.duplicates.map(d => d.name),
      confidence: g.confidence,
    })),
  };
};

/**
 * Delete duplicate GPX files from a user-selected folder.
 *
 * @param {Array} filesToDelete - [{ uri, name }]
 * @param {Function} onProgress - callback(current, total, fileName)
 * @returns {Object} result
 */
export const deleteDuplicateGPXFiles = async (filesToDelete, onProgress = null) => {
  let deleted = 0;
  let failed = 0;
  const failedFiles = [];

  for (let i = 0; i < filesToDelete.length; i++) {
    const f = filesToDelete[i];
    if (onProgress) onProgress(i + 1, filesToDelete.length, f.name);

    try {
      await FileSystem.StorageAccessFramework.deleteAsync(f.uri);
      deleted++;
    } catch (e) {
      console.log(`[folder-cleanup] Could not delete ${f.name}: ${e.message}`);
      failed++;
      failedFiles.push({ name: f.name, error: e.message });
    }
  }

  return { success: true, deleted, failed, failedFiles };
};

/**
 * Import selected GPX files
 * 
 * @param {Array} gpxFiles - Array of file objects from document picker
 * @param {Object} metadata - Optional metadata from activities.csv
 * @param {Function} onProgress - Callback for progress updates (current, total, filename)
 * @returns {Object} Import results
 */
export const importSelectedFiles = async (gpxFiles, metadata = {}, onProgress = null) => {
  try {
    if (!gpxFiles || gpxFiles.length === 0) {
      return {
        success: false,
        error: 'No GPX files selected',
        imported: 0,
        failed: 0,
      };
    }

    // --- Dedup: build signatures for all existing internal activities ---
    const { signatureFromGPXContent, isDuplicate, buildSignature } = require('./gpxIdentity');
    const { getSavedActivityIds, loadActivityFromFile } = require('./fileStorage');

    const internalIds = new Set(await getSavedActivityIds());
    const internalSignatures = [];

    for (const id of internalIds) {
      try {
        const activity = await loadActivityFromFile(id);
        if (activity) {
          const routeData = activity.routeData || activity.route || [];
          const sig = buildSignature({
            routeData,
            timestamp: activity.timestamp,
            distance: activity.distance,
            duration: activity.duration,
            type: activity.type,
            id: activity.id,
          });
          if (sig) internalSignatures.push(sig);
        }
      } catch (e) {
        // Skip activities that can't be loaded
      }
    }

    console.log(`[import] Built ${internalSignatures.length} internal signatures for dedup`);

    let imported = 0;
    let failed = 0;
    let skippedDuplicates = 0;
    const errors = [];
    const importedActivities = [];

    for (let i = 0; i < gpxFiles.length; i++) {
      const file = gpxFiles[i];
      const fileName = file.name;

      if (onProgress) {
        onProgress(i + 1, gpxFiles.length, fileName);
      }

      // Read GPX content for dedup check
      let gpxContent;
      try {
        if (file.uri.startsWith('content://')) {
          gpxContent = await FileSystem.StorageAccessFramework.readAsStringAsync(file.uri);
        } else {
          gpxContent = await FileSystem.readAsStringAsync(file.uri);
        }
      } catch (e) {
        failed++;
        errors.push({ file: fileName, error: `Could not read file: ${e.message}` });
        continue;
      }

      // Build signature from GPX content
      const importSig = signatureFromGPXContent(gpxContent);

      // Check against internal activities
      const isDup = importSig ? internalSignatures.some(is => isDuplicate(importSig, is)) : false;

      if (isDup) {
        console.log(`[import] Skipping duplicate: ${fileName}`);
        skippedDuplicates++;
        continue;
      }

      // Also check for duplicates within this import batch
      const isBatchDup = importedActivities.some(a => {
        const routeData = a.routeData || a.route || [];
        const aSig = buildSignature({ routeData, timestamp: a.timestamp, distance: a.distance, duration: a.duration, type: a.type, id: a.id });
        return isDuplicate(importSig, aSig);
      });

      if (isBatchDup) {
        console.log(`[import] Skipping intra-batch duplicate: ${fileName}`);
        skippedDuplicates++;
        continue;
      }

      // Look up metadata by filename
      const fileMetadata = metadata[fileName] || null;

      const result = await importGPXFromUri(file.uri, fileName, fileMetadata);

      if (result.success) {
        imported++;
        importedActivities.push(result.activity);
        // Add to internal signatures so subsequent files are checked against it
        const routeData = result.activity.routeData || result.activity.route || [];
        const newSig = buildSignature({ routeData, timestamp: result.activity.timestamp, distance: result.activity.distance, duration: result.activity.duration, type: result.activity.type, id: result.activity.id });
        if (newSig) internalSignatures.push(newSig);
      } else {
        failed++;
        errors.push({ file: fileName, error: result.error });
      }
    }
    
    // Batch save all imported activities to AsyncStorage at the end
    // This ensures consistency and avoids race conditions
    if (importedActivities.length > 0) {
      try {
        const existingJson = await AsyncStorage.getItem(ACTIVITIES_KEY);
        const existingActivities = existingJson ? JSON.parse(existingJson) : [];
        
        // Create a map of existing activities by id for faster lookup
        const existingMap = new Map();
        existingActivities.forEach(a => {
          existingMap.set(a.id, a);
          if (a.stravaId) existingMap.set(a.stravaId, a);
        });
        
        // Add or update imported activities
        // IMPORTANT: Don't include routeData in AsyncStorage - it's too large
        // routeData is stored separately in file storage
        for (const activity of importedActivities) {
          // Create a copy without routeData for AsyncStorage
          const activityForStorage = { ...activity };
          delete activityForStorage.routeData;
          
          const existingById = existingMap.get(activity.id);
          const existingByStravaId = activity.stravaId ? existingMap.get(activity.stravaId) : null;
          
          if (existingById) {
            // Update existing by id
            const idx = existingActivities.findIndex(a => a.id === activity.id);
            if (idx >= 0) existingActivities[idx] = activityForStorage;
          } else if (existingByStravaId) {
            // Update existing by stravaId
            const idx = existingActivities.findIndex(a => a.stravaId === activity.stravaId);
            if (idx >= 0) existingActivities[idx] = activityForStorage;
          } else {
            // Add new
            existingActivities.push(activityForStorage);
          }
          
          // Update map for next iteration
          existingMap.set(activity.id, activityForStorage);
          if (activity.stravaId) existingMap.set(activity.stravaId, activityForStorage);
        }
        
        const jsonToSave = JSON.stringify(existingActivities);
        console.log(`Saving to AsyncStorage: ${importedActivities.length} new activities, total ${existingActivities.length}, size: ${(jsonToSave.length / 1024).toFixed(1)}KB`);
        
        await AsyncStorage.setItem(ACTIVITIES_KEY, jsonToSave);
        console.log('AsyncStorage save completed successfully');
      } catch (asyncError) {
        console.error('Error batch saving to AsyncStorage:', asyncError);
        console.error('Error details:', asyncError.message);
      }
    }
    
    // Recalculate gamification after import using AsyncStorage data
    if (imported > 0) {
      try {
        const allActivitiesJson = await AsyncStorage.getItem(ACTIVITIES_KEY);
        const allActivities = allActivitiesJson ? JSON.parse(allActivitiesJson) : [];
        const gamification = await recalculateGamification(allActivities);
        await saveGamificationToFile(gamification);
      } catch (gamError) {
        console.error('Error recalculating gamification:', gamError);
      }
    }
    
    return {
      success: true,
      imported,
      failed,
      skipped: skippedDuplicates,
      total: gpxFiles.length,
      errors: errors.slice(0, 10), // Only return first 10 errors
    };
  } catch (error) {
    console.error('Error importing files:', error);
    return {
      success: false,
      error: error.message,
      imported: 0,
      failed: 0,
    };
  }
};
