const ACTIVITY_TYPES = Object.freeze([
  Object.freeze({ id: 'walking', label: 'Walking', shortLabel: 'Walk', resultNoun: 'Walk', importedNoun: 'Walk', routeColor: '#1976D2', gpxType: 'walking', metricMode: 'pace', icon: 'walk' }),
  Object.freeze({ id: 'running', label: 'Running', shortLabel: 'Run', resultNoun: 'Run', importedNoun: 'Run', routeColor: '#AB47BC', gpxType: 'running', metricMode: 'pace', icon: 'run-fast' }),
  Object.freeze({ id: 'biking', label: 'Biking', shortLabel: 'Bike', resultNoun: 'Ride', importedNoun: 'Ride', routeColor: '#D32F2F', gpxType: 'cycling', metricMode: 'speed', icon: 'bike' }),
]);

const UNKNOWN_ACTIVITY_TYPE = Object.freeze({
  id: 'unknown',
  label: 'Activity',
  shortLabel: 'Activity',
  resultNoun: 'Activity',
  importedNoun: 'Activity',
  routeColor: '#757575',
  gpxType: null,
  metricMode: 'unknown',
  icon: 'help-circle-outline',
});

const BY_ID = Object.freeze(Object.fromEntries(ACTIVITY_TYPES.map(type => [type.id, type])));

const IMPORT_TYPE_MAP = Object.freeze({
  walk: 'walking',
  walking: 'walking',
  hike: 'walking',
  hiking: 'walking',
  run: 'running',
  running: 'running',
  ride: 'biking',
  cycling: 'biking',
  mountainbikeride: 'biking',
  gravelride: 'biking',
  ebikeride: 'biking',
  virtualride: 'biking',
  biking: 'biking',
});

const getActivityType = (id) => BY_ID[id] || UNKNOWN_ACTIVITY_TYPE;
const isKnownActivityType = (id) => Boolean(BY_ID[id]);
const getActivityLabel = (id) => getActivityType(id).label;
const getActivityRouteColor = (id) => getActivityType(id).routeColor;
const usesPace = (id) => getActivityType(id).metricMode === 'pace';
const toGPXActivityType = (id) => getActivityType(id).gpxType || 'walking';
const fromImportedActivityType = (value, fallback = 'walking') => {
  if (typeof value !== 'string') return fallback;
  return IMPORT_TYPE_MAP[value.trim().toLowerCase()] || fallback;
};
const getDefaultActivityName = (id, imported = false) => {
  const definition = getActivityType(id);
  return imported ? `Imported ${definition.importedNoun}` : definition.resultNoun;
};

module.exports = {
  ACTIVITY_TYPES,
  UNKNOWN_ACTIVITY_TYPE,
  IMPORT_TYPE_MAP,
  getActivityType,
  isKnownActivityType,
  getActivityLabel,
  getActivityRouteColor,
  usesPace,
  toGPXActivityType,
  fromImportedActivityType,
  getDefaultActivityName,
};
