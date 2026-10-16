const DEFAULT_PROGRESS_SETTINGS = Object.freeze({
  walking: Object.freeze({ daily: 10, weekly: 10, monthly: 10 }),
  running: Object.freeze({ daily: 10, weekly: 10, monthly: 10 }),
  biking: Object.freeze({ daily: 10, weekly: 10, monthly: 10 }),
});

const mergeProgressSettings = (saved = {}) => Object.fromEntries(
  Object.entries(DEFAULT_PROGRESS_SETTINGS).map(([type, defaults]) => [
    type,
    { ...defaults, ...(saved[type] || {}) },
  ])
);

module.exports = { DEFAULT_PROGRESS_SETTINGS, mergeProgressSettings };
