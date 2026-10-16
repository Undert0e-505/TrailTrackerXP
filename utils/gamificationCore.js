const DEFAULT_GAMIFICATION_STATS = Object.freeze({
  totalDistance: 0,
  totalActivities: 0,
  totalElevation: 0,
  walkingActivities: 0,
  walkingDistance: 0,
  walkingElevation: 0,
  runningActivities: 0,
  runningDistance: 0,
  runningElevation: 0,
  bikingActivities: 0,
  bikingDistance: 0,
  bikingElevation: 0,
  bikingDescent: 0,
  currentStreak: 0,
  longestStreak: 0,
  lastActivityDate: null,
  hasWeekendPair: false,
  weekendDays: [],
});

const mergeGamificationStats = (stats = {}) => ({ ...DEFAULT_GAMIFICATION_STATS, ...stats });

const addActivityToStats = (stats, activity) => {
  const next = mergeGamificationStats(stats);
  next.totalDistance += activity.distance || 0;
  next.totalActivities += 1;
  next.totalElevation += activity.elevationGain || 0;
  if (activity.type === 'walking') {
    next.walkingActivities += 1;
    next.walkingDistance += activity.distance || 0;
    next.walkingElevation += activity.elevationGain || 0;
  } else if (activity.type === 'running') {
    next.runningActivities += 1;
    next.runningDistance += activity.distance || 0;
    next.runningElevation += activity.elevationGain || 0;
  } else if (activity.type === 'biking') {
    next.bikingActivities += 1;
    next.bikingDistance += activity.distance || 0;
    next.bikingElevation += activity.elevationGain || 0;
    next.bikingDescent += activity.elevationLoss || 0;
  }
  return next;
};

const getPeriodStart = (period, now = new Date()) => {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'weekly') {
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
  }
  return start;
};

const filterChallengeActivities = (activities, { activityType, startAt } = {}) => activities.filter(activity => {
  if (activityType && activity.type !== activityType) return false;
  if (startAt && new Date(activity.date || activity.timestamp || 0) < new Date(startAt)) return false;
  return true;
});

const calculateChallengeProgress = (challenge, activities, currentStreak = 0) => {
  const relevant = filterChallengeActivities(activities, {
    activityType: challenge.activityType,
    startAt: challenge.startAt,
  });
  switch (challenge.type) {
    case 'distance': return relevant.reduce((sum, activity) => sum + (activity.distance || 0), 0);
    case 'count': return relevant.length;
    case 'streak': return currentStreak || 0;
    case 'single_distance': return relevant.length ? Math.max(...relevant.map(activity => activity.distance || 0)) : 0;
    case 'duration': return relevant.length ? Math.max(...relevant.map(activity => (activity.duration || 0) / 60)) : 0;
    default: return 0;
  }
};

module.exports = {
  DEFAULT_GAMIFICATION_STATS,
  mergeGamificationStats,
  addActivityToStats,
  getPeriodStart,
  filterChallengeActivities,
  calculateChallengeProgress,
};
