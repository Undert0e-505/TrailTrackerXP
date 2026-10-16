const assert = require('assert');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '..');
const memory = new Map();
const asyncStorage = {
  getItem: async key => memory.has(key) ? memory.get(key) : null,
  setItem: async (key, value) => { memory.set(key, value); },
  removeItem: async key => { memory.delete(key); },
};
const expoFileSystem = { documentDirectory: 'file:///test/' };
const moduleCache = new Map();

function loadSourceModule(filePath, mocks = {}) {
  const absolute = path.resolve(filePath);
  if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports;
  const module = { exports: {} };
  moduleCache.set(absolute, module);
  const code = babel.transformFileSync(absolute, {
    presets: ['babel-preset-expo'],
    babelrc: false,
    configFile: false,
  }).code;
  const localRequire = request => {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: asyncStorage };
    if (request === 'expo-file-system') return expoFileSystem;
    if (mocks[request]) return mocks[request];
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(absolute), request.endsWith('.js') ? request : `${request}.js`);
      return loadSourceModule(resolved, mocks);
    }
    return require(request);
  };
  Function('require', 'module', 'exports', '__filename', '__dirname', code)(
    localRequire, module, module.exports, absolute, path.dirname(absolute)
  );
  return module.exports;
}

const activityTypes = require(path.join(root, 'utils/activityTypes'));
const progressSettings = require(path.join(root, 'utils/progressSettings'));
const gamificationCore = require(path.join(root, 'utils/gamificationCore'));
const fileStorage = loadSourceModule(path.join(root, 'utils/fileStorage.js'));
const gamification = loadSourceModule(path.join(root, 'utils/gamification.js'));

async function run() {
  assert.deepStrictEqual(activityTypes.ACTIVITY_TYPES.map(type => type.id), ['walking', 'running', 'biking']);
  assert.strictEqual(activityTypes.getActivityType('walking').routeColor, '#1976D2');
  assert.strictEqual(activityTypes.getActivityType('running').routeColor, '#AB47BC');
  assert.strictEqual(activityTypes.getActivityType('biking').routeColor, '#D32F2F');
  assert.strictEqual(activityTypes.getActivityType('running').metricMode, 'pace');
  assert.strictEqual(activityTypes.getActivityType('biking').metricMode, 'speed');
  assert.strictEqual(activityTypes.getActivityType('other').label, 'Activity');
  assert.strictEqual(activityTypes.getActivityType('other').metricMode, 'unknown');

  const point = { latitude: 51.5, longitude: -0.1, altitude: 10, timestamp: 1700000000000 };
  for (const type of activityTypes.ACTIVITY_TYPES) {
    const xml = fileStorage.activityToGPX({ id: type.id, type: type.id, timestamp: new Date(point.timestamp).toISOString(), routeData: [point] });
    const parsed = fileStorage.parseGPX(xml);
    assert.strictEqual(activityTypes.fromImportedActivityType(parsed.type), type.id, `${type.id} GPX roundtrip`);
  }
  assert.strictEqual(activityTypes.fromImportedActivityType('Run'), 'running');
  assert.strictEqual(activityTypes.fromImportedActivityType('running'), 'running');
  assert.strictEqual(activityTypes.fromImportedActivityType('Hike'), 'walking');
  assert.strictEqual(activityTypes.fromImportedActivityType('Ride'), 'biking');
  assert.strictEqual(activityTypes.fromImportedActivityType('unrecognised'), 'walking');

  const mergedProgress = progressSettings.mergeProgressSettings({ walking: { daily: 4 }, biking: { weekly: 7 } });
  assert.deepStrictEqual(mergedProgress.walking, { daily: 4, weekly: 10, monthly: 10 });
  assert.deepStrictEqual(mergedProgress.running, { daily: 10, weekly: 10, monthly: 10 });
  assert.deepStrictEqual(mergedProgress.biking, { daily: 10, weekly: 7, monthly: 10 });

  const mergedStats = gamificationCore.mergeGamificationStats({ walkingActivities: 9, bikingDistance: 12 });
  assert.strictEqual(mergedStats.walkingActivities, 9);
  assert.strictEqual(mergedStats.runningActivities, 0);
  assert.strictEqual(mergedStats.runningDistance, 0);
  assert.strictEqual(mergedStats.runningElevation, 0);
  assert.strictEqual(mergedStats.bikingDistance, 12);

  let stats = gamificationCore.addActivityToStats({}, { type: 'walking', distance: 2, elevationGain: 3 });
  stats = gamificationCore.addActivityToStats(stats, { type: 'running', distance: 5, elevationGain: 8 });
  stats = gamificationCore.addActivityToStats(stats, { type: 'biking', distance: 9, elevationGain: 4, elevationLoss: 6 });
  assert.deepStrictEqual(
    [stats.walkingActivities, stats.runningActivities, stats.bikingActivities],
    [1, 1, 1]
  );
  assert.strictEqual(stats.runningDistance, 5);

  const mixed = [
    { type: 'walking', distance: 8, duration: 1800, timestamp: '2026-10-16T09:00:00Z' },
    { type: 'running', distance: 4, duration: 1500, timestamp: '2026-10-16T10:00:00Z' },
    { type: 'biking', distance: 20, duration: 3600, timestamp: '2026-10-16T11:00:00Z' },
  ];
  const typed = gamificationCore.calculateChallengeProgress({ type: 'distance', activityType: 'running' }, mixed);
  const generic = gamificationCore.calculateChallengeProgress({ type: 'distance' }, mixed);
  assert.strictEqual(typed, 4);
  assert.strictEqual(generic, 32);
  const bounded = gamification.getSelectedChallengeProgress(
    { type: 'distance', activityType: 'running', target: 2, selectedAt: '2026-10-16T09:30:00Z' },
    mixed,
    0
  );
  assert.strictEqual(bounded.progress, 4);
  assert.strictEqual(bounded.completed, true);

  assert.strictEqual(gamification.ACHIEVEMENTS.run_5km.check({}, { type: 'running', distance: 5 }), true);
  assert.strictEqual(gamification.ACHIEVEMENTS.run_5km.check({}, { type: 'walking', distance: 5 }), false);
  assert.strictEqual(gamification.ACHIEVEMENTS.run_half_marathon.check({}, { type: 'running', distance: 21.1 }), true);
  assert.strictEqual(gamification.ACHIEVEMENTS.run_marathon.check({}, { type: 'running', distance: 42.194 }), false);
  for (const [id, threshold] of Object.entries({ run_first_km: 1, run_3km: 3, run_5km: 5, run_10km: 10, run_half_marathon: 21.1, run_marathon: 42.195 })) {
    assert.strictEqual(gamification.ACHIEVEMENTS[id].check({}, { type: 'running', distance: threshold }), true, id);
  }
  for (const [id, threshold] of Object.entries({ run_total_10km: 10, run_total_50km: 50, run_total_100km: 100, run_total_250km: 250, run_total_500km: 500, run_total_1000km: 1000 })) {
    assert.strictEqual(gamification.ACHIEVEMENTS[id].check({ runningDistance: threshold }), true, id);
  }
  for (const [id, threshold] of Object.entries({ run_climb_50m: 50, run_climb_100m: 100, run_climb_250m: 250 })) {
    assert.strictEqual(gamification.ACHIEVEMENTS[id].check({}, { type: 'running', elevationGain: threshold }), true, id);
  }
  for (const [id, threshold] of Object.entries({ run_total_elevation_500m: 500, run_total_elevation_2000m: 2000 })) {
    assert.strictEqual(gamification.ACHIEVEMENTS[id].check({ runningElevation: threshold }), true, id);
  }
  for (const [id, threshold] of Object.entries({ run_5_activities: 5, run_20_activities: 20, run_50_activities: 50, run_100_activities: 100 })) {
    assert.strictEqual(gamification.ACHIEVEMENTS[id].check({ runningActivities: threshold }), true, id);
  }
  assert.strictEqual(gamification.ACHIEVEMENTS.all_three_types.check({ walkingActivities: 1, runningActivities: 1, bikingActivities: 1 }), true);
  assert.strictEqual(gamification.ACHIEVEMENTS.both_types.check({ walkingActivities: 1, bikingActivities: 1 }), true);

  memory.clear();
  await gamification.processActivity(
    { type: 'running', distance: 1, duration: 600, elevationGain: 10, timestamp: new Date().toISOString() },
    [{ type: 'running', distance: 1, duration: 600, elevationGain: 10, timestamp: new Date().toISOString() }]
  );
  const processed = await gamification.loadGamification();
  assert.strictEqual(processed.stats.runningActivities, 1);
  assert.strictEqual(processed.stats.walkingActivities, 0);
  assert.strictEqual(processed.stats.bikingActivities, 0);

  memory.clear();
  const selectedAt = '2026-10-16T09:30:00Z';
  memory.set('@trail_tracker_selected_challenge', JSON.stringify({
    templateId: 'daily_run_distance', type: 'distance', activityType: 'running', target: 3,
    unit: 'km', description: 'Run 3km today', bonusXp: 100, selectedAt, bonusXpAwarded: true,
  }));
  memory.set('@trail_tracker_challenge_rewards', JSON.stringify([
    { challengeId: 'daily_run_distance', selectedAt, xp: 100, source: 'selected_challenge' },
  ]));
  const recalculated = await gamification.recalculateGamification(mixed, null);
  const xpAfterFirst = recalculated.xp;
  const recalculatedAgain = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(recalculatedAgain.xp, xpAfterFirst, 'recalculation must not duplicate challenge XP');
  assert.strictEqual(recalculatedAgain.stats.runningActivities, 1);
  const preservedSelected = JSON.parse(memory.get('@trail_tracker_selected_challenge'));
  assert.strictEqual(preservedSelected.selectedAt, selectedAt);
  assert.strictEqual(preservedSelected.bonusXpAwarded, true);
  assert.strictEqual(JSON.parse(memory.get('@trail_tracker_challenge_rewards')).length, 1);

  memory.clear();
  memory.set('@trail_tracker_selected_challenge', JSON.stringify({
    templateId: 'daily_run_distance', type: 'distance', activityType: 'running', target: 3,
    unit: 'km', description: 'Run 3km today', bonusXp: 100, selectedAt, bonusXpAwarded: false,
  }));
  const newlyAwarded = await gamification.recalculateGamification(mixed, null);
  const newlyAwardedXp = newlyAwarded.xp;
  const afterAwardReplay = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(afterAwardReplay.xp, newlyAwardedXp, 'new challenge reward must remain idempotent');
  assert.strictEqual(JSON.parse(memory.get('@trail_tracker_challenge_rewards')).length, 1);
  assert.strictEqual(JSON.parse(memory.get('@trail_tracker_selected_challenge')).bonusXpAwarded, true);

  memory.set('@trail_tracker_gamification', JSON.stringify({
    xp: 125,
    challenges: [{ rewarded: true }],
    stats: {},
  }));
  const migratedChallengeXp = await gamification.loadGamification();
  assert.strictEqual(migratedChallengeXp.challengeXp, 125, 'legacy reward ledger and automatic rewards must migrate');

  memory.clear();
  memory.set('@trail_tracker_gamification', JSON.stringify({ challengeXp: 75, xp: 75, challenges: [], stats: {} }));
  const withPreservedAutomaticRewards = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(withPreservedAutomaticRewards.challengeXp, 75, 'expired automatic challenge rewards must survive recalculation');
  memory.clear();
  const withoutPreservedAutomaticRewards = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(
    withPreservedAutomaticRewards.xp - withoutPreservedAutomaticRewards.xp,
    75,
    'preserved challenge XP must remain separate from activity and achievement XP'
  );

  memory.clear();
  memory.set('@trail_tracker_gamification', JSON.stringify({
    challengeXp: 0,
    xp: 0,
    challenges: [{
      id: 'run_conversion_challenge', templateId: 'daily_run_distance', type: 'distance',
      activityType: 'running', target: 3, progress: 0, completed: false, rewarded: false,
      period: 'daily', periodStart: '2026-10-16T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    }],
    stats: {},
  }));
  const completedByRecalculation = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(completedByRecalculation.challenges[0].rewarded, true);
  assert.strictEqual(completedByRecalculation.challengeXp, 25);
  const replayedAutomaticReward = await gamification.recalculateGamification(mixed, null);
  assert.strictEqual(replayedAutomaticReward.challengeXp, 25, 'automatic reward must not duplicate after recalculation');

  const runningTemplates = gamification.CHALLENGE_TEMPLATES.filter(template => template.activityType === 'running');
  assert.deepStrictEqual(runningTemplates.map(template => template.id), [
    'daily_run_distance', 'weekly_run_distance', 'weekly_run_count', 'single_run_distance', 'single_run_duration',
  ]);
  assert.strictEqual(gamificationCore.getPeriodStart('weekly', new Date('2026-10-18T12:00:00')).getDay(), 1);

  console.log('All TrailTrackerXP logic tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
