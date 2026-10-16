# Challenge System

TrailTrackerXP provides automatic challenges and one user-selected challenge. Both use the
canonical activity types `walking`, `running` and `biking`.

## Templates

Templates live in `utils/gamification.js`. Generic templates count walks, runs and rides. Running
templates set `activityType: 'running'`, which filters every progress path to runs only:

| Template | Period | Targets |
|---|---|---|
| Daily run distance | Daily | 1, 3, 5 km |
| Weekly run distance | Weekly | 5, 10, 15, 20 km |
| Weekly run count | Weekly | 2, 3, 5 runs |
| Single run distance | Weekly | 3, 5, 10 km |
| Single run duration | Weekly | 20, 30, 45, 60 minutes |

Templates without `activityType` remain backward-compatible and count every activity type.

## Time windows

- Daily challenges begin at local midnight and expire at the next local midnight.
- Weekly challenges begin on Monday and expire the following Monday, matching Stats.
- Existing active weekly challenges saved before the Monday-boundary change retain their legacy
  Sunday window until they expire; newly generated challenges persist an explicit `periodStart`.
- Selected challenges count only activities at or after their immutable `selectedAt` timestamp.

## Generation and offers

`getOfferableChallenges()` expands every template/target pair and removes:

1. the same template and target when it is already an incomplete selected or automatic challenge;
2. variants already completed in their current daily or weekly rule window.

`generateChallenges()` chooses up to three entries from that filtered pool. It receives current
activities, the selected challenge, and existing automatic challenges so duplicate filtering is
not bypassed.

## Progress

All automatic, selected, and offer-filtering paths share the same progress rules:

- `distance`: sum distance;
- `count`: count activities;
- `streak`: use the current activity streak;
- `single_distance`: use the longest matching activity;
- `duration`: use the longest matching activity duration in minutes.

When `activityType` is present, non-matching activities are excluded before applying the rule.

## Rewards and recalculation

- Automatic challenges award 25 XP once and persist `rewarded: true`.
- Selected challenges award 50, 100 or 250 XP according to target difficulty.
- Total challenge XP is stored separately so recalculating activity-derived XP does not discard
  rewards after completed challenge cards expire from the display.
- The selected-challenge reward ledger is keyed by template identity and `selectedAt`, preventing a
  duplicate reward even if the activity history is recalculated.
- Conversion and deletion rebuild activity XP, stats and achievements while preserving automatic
  challenge history/rewards, the selected challenge identity and timestamp, and its reward ledger.
  Active challenge progress is recalculated against the updated activity types.

## Storage

- Gamification state: `@trail_tracker_gamification`
- Selected challenge: `@trail_tracker_selected_challenge`
- Selected reward ledger: `@trail_tracker_challenge_rewards`
- File backup: `documentDirectory/activities/gamification.json`
