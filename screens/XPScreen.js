import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  Modal,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import Svg, { Path, Circle as SvgCircle, Text as SvgText, Line } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../utils/theme';
import { getActivities, formatDistance, formatDuration } from '../utils/storage';
import {
  loadGamification,
  ACHIEVEMENTS,
  LEVELS,
  getLevelForXP,
  getXPProgress,
  getDistanceComparison,
  generateChallenges,
  updateChallengeProgress,
  calculateStreak,
  saveGamification,
  getStatsCutoffDate,
  filterActivitiesByCutoff,
  getChallengeTemplates,
  getOfferableChallenges,
  selectChallenge,
  getSelectedChallenge,
  abandonSelectedChallenge,
  getSelectedChallengeProgress,
} from '../utils/gamification';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ChevronRightIcon, TrackIcon } from '../components/Icons';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Local SVG icons (same as StatsScreen)
const ChevronUpIcon = ({ size = 20, color = '#424242' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M18 15l-6-6-6 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const ChevronDownIcon = ({ size = 20, color = '#424242' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M6 9l6 6 6-6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const TrophyIcon = ({ size = 24, color = '#FFD700' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M6 9H4a2 2 0 01-2-2V5a2 2 0 012-2h2M18 9h2a2 2 0 002-2V5a2 2 0 00-2-2h-2M6 9v3a6 6 0 006 6v0a6 6 0 006-6V9M6 9h12M9 21h6M12 18v3" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

const StarIcon = ({ size = 24, color = '#9C27B0' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
  </Svg>
);

const FireIcon = ({ size = 24, color = '#FF5722' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M12 2c0 3-2 5-2 8 0 1.5.5 3 2 4 1.5-1 2-2.5 2-4 0-3-2-5-2-8z" fill={color} />
    <Path d="M8 12c0 2.5 1.5 4 4 5 2.5-1 4-2.5 4-5 0-1.5-.5-3-1.5-4-.5 1.5-1.5 2.5-2.5 2.5s-2-1-2.5-2.5c-1 1-1.5 2.5-1.5 4z" fill={color} />
  </Svg>
);

const TargetIcon = ({ size = 24, color = '#2196F3' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <SvgCircle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" />
    <SvgCircle cx="12" cy="12" r="6" stroke={color} strokeWidth="2" />
    <SvgCircle cx="12" cy="12" r="2" fill={color} />
  </Svg>
);

const PROGRESS_SETTINGS_KEY = '@trail_tracker_progress_settings';

const TIER_COLORS = {
  bronze: '#B87333',
  silver: '#BFC7D5',
  gold: '#F5C542',
};

// Dev-time icon validation — catches invalid MCI names before they render as '?'
const FALLBACK_ICON = 'trophy-outline';
const isValidIconName = (name) => {
  try {
    return !!MaterialCommunityIcons.glyphMap[name];
  } catch {
    return true; // glyphMap not accessible in all environments; skip check
  }
};
const safeIconName = (name, achievementId) => {
  if (!isValidIconName(name)) {
    console.warn(`[XPScreen] Invalid icon "${name}" for achievement "${achievementId}" — using fallback`);
    return FALLBACK_ICON;
  }
  return name;
};

export default function XPScreen() {
  const { theme, distanceUnit } = useTheme();
  const navigation = useNavigation();
  const [activities, setActivities] = useState([]);
  const [gamification, setGamification] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedChallenge, setSelectedChallenge] = useState(null);
  const [showChallengePicker, setShowChallengePicker] = useState(false);
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);
  const [showAchievementModal, setShowAchievementModal] = useState(false);
  const [selectedAchievement, setSelectedAchievement] = useState(null);
  const [cutoffDate, setCutoffDate] = useState(null);

  // Helper to render achievement icons - handles stacked flames for streak achievements
  const renderAchievementIcon = (iconName, fontSize, isUnlocked = true, tier = null, achievementId = null) => {
    const tierColor = tier ? TIER_COLORS[tier] : theme.accent;
    const color = isUnlocked ? tierColor : theme.textSecondary;
    const opacity = isUnlocked ? 1 : 0.3;
    if (Array.isArray(iconName)) {
      const safeNames = iconName.map(n => safeIconName(n, achievementId));
      const count = Math.min(safeNames.length, 3);
      // Compact cluster: 3 icons in a triangle, 2 icons overlapping
      if (count === 2) {
        return (
          <View style={styles.iconCluster}>
            {safeNames.slice(0, 2).map((name, i) => (
              <MaterialCommunityIcons key={i} name={name} size={Math.floor(fontSize * 0.7)} color={color} style={[styles.clusterIcon, i === 0 ? styles.clusterTwoLeft : styles.clusterTwoRight, { opacity }]} />
            ))}
          </View>
        );
      }
      // count === 3: triangle layout
      return (
        <View style={styles.iconCluster}>
          {safeNames.slice(0, 3).map((name, i) => (
            <MaterialCommunityIcons key={i} name={name} size={Math.floor(fontSize * 0.65)} color={color} style={[styles.clusterIcon, i === 0 ? styles.clusterTop : i === 1 ? styles.clusterBottomLeft : styles.clusterBottomRight, { opacity }]} />
          ))}
        </View>
      );
    }
    return <MaterialCommunityIcons name={safeIconName(iconName, achievementId)} size={fontSize} color={color} style={{ opacity }} />;
  };

  const getTotalDistance = () => {
    if (!activities || activities.length === 0) return 0;
    if (cutoffDate) {
      return filterActivitiesByCutoff(activities, cutoffDate).reduce((sum, a) => sum + (a.distance || 0), 0);
    }
    return activities.reduce((sum, a) => sum + (a.distance || 0), 0);
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    const activitiesData = await getActivities();
    setActivities(activitiesData);

    const cutoff = await getStatsCutoffDate();
    setCutoffDate(cutoff);

    let gamificationData = await loadGamification();

    // Load selected challenge early so we can filter challenge generation
    const selChallenge = await getSelectedChallenge();

    if (activitiesData.length > 0) {
      gamificationData.stats.currentStreak = calculateStreak(activitiesData);

      const now = new Date();
      const lastGen = gamificationData.lastChallengeGeneration
        ? new Date(gamificationData.lastChallengeGeneration)
        : null;

      const needsNewChallenges = !lastGen ||
        (now.getDate() !== lastGen.getDate()) ||
        gamificationData.challenges.filter(c => !c.completed && !c.expired).length === 0;

      if (needsNewChallenges) {
        const newChallenges = generateChallenges(gamificationData.stats, activitiesData, selChallenge, gamificationData.challenges);
        gamificationData.challenges = [
          ...gamificationData.challenges.filter(c => !c.expired && (c.completed || !c.rewarded)),
          ...newChallenges
        ].slice(-10);
        gamificationData.lastChallengeGeneration = now.toISOString();
      }

      gamificationData.challenges = updateChallengeProgress(
        gamificationData.challenges,
        activitiesData,
        gamificationData.stats.currentStreak
      );

      await saveGamification(gamificationData);
    }

    setGamification(gamificationData);

    // Update selected challenge progress
    if (selChallenge) {
      const withProgress = getSelectedChallengeProgress(selChallenge, activitiesData, gamificationData.stats.currentStreak);
      setSelectedChallenge(withProgress);
    } else {
      setSelectedChallenge(null);
    }
  };

  // --- Level Card ---
  const renderLevelCard = () => {
    if (!gamification) return null;
    const level = getLevelForXP(gamification.xp);
    const xpProgress = getXPProgress(gamification.xp);

    const calculateWeekStreak = () => {
      if (activities.length === 0) return 0;
      const getWeekStart = (date) => {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      };
      const weeksWithActivities = new Set(activities.map(a => getWeekStart(a.timestamp)));
      const sortedWeeks = Array.from(weeksWithActivities).sort((a, b) => b - a);
      if (sortedWeeks.length === 0) return 0;
      const currentWeekStart = getWeekStart(new Date());
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      if (sortedWeeks[0] < currentWeekStart - oneWeekMs) return 0;
      let streak = 1;
      let expectedWeek = sortedWeeks[0] - oneWeekMs;
      for (let i = 1; i < sortedWeeks.length; i++) {
        if (sortedWeeks[i] === expectedWeek) { streak++; expectedWeek -= oneWeekMs; }
        else if (sortedWeeks[i] < expectedWeek) break;
      }
      return streak;
    };

    const weekStreak = calculateWeekStreak();

    return (
      <View style={[styles.levelCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.levelHeader}>
          <View style={[styles.levelIconContainer, { backgroundColor: 'rgba(156, 39, 176, 0.08)' }]}>
            <MaterialCommunityIcons name={level.icon} size={32} color={theme.accent} />
          </View>
          <View style={styles.levelInfo}>
            <Text style={[styles.levelName, { color: theme.text }]}>{level.name}</Text>
            <Text style={[styles.levelNumber, { color: theme.textSecondary }]}>Level {level.level}</Text>
          </View>
        </View>
        <View style={[styles.xpDisplayLarge, { backgroundColor: 'rgba(156, 39, 176, 0.08)' }]}>
          <StarIcon size={32} color={theme.xp} />
          <Text style={[styles.xpValueLarge, { color: theme.xp }]}>{gamification.xp}</Text>
          <Text style={[styles.xpLabelLarge, { color: theme.xp }]}>XP</Text>
        </View>
        {xpProgress.nextLevel && (
          <View style={styles.xpProgressContainer}>
            <View style={[styles.xpProgressBar, { backgroundColor: theme.surface }]}>
              <View style={[styles.xpProgressFill, { backgroundColor: theme.xp, width: `${xpProgress.progress * 100}%` }]} />
            </View>
            <Text style={[styles.xpProgressText, { color: theme.textSecondary }]}>
              {xpProgress.current} / {xpProgress.required} XP to {xpProgress.nextLevel.name}
            </Text>
          </View>
        )}
        {weekStreak > 0 && (
          <View style={[styles.streakBadge, { backgroundColor: theme.surface }]}>
            <FireIcon size={18} color="#FF5722" />
            <Text style={[styles.streakText, { color: theme.text }]}>{weekStreak} week streak!</Text>
          </View>
        )}
      </View>
    );
  };

  // --- Distance/Landmark Card ---
  const renderDistanceCard = () => {
    const totalKm = getTotalDistance();
    const comparison = getDistanceComparison(totalKm);
    return (
      <View style={[styles.distanceCard, { backgroundColor: theme.cardBg }]}>
        <Text style={[styles.distanceTitle, { color: theme.text }]}>Journey Progress</Text>
        <View style={styles.distanceMain}>
          <Text style={[styles.distanceValue, { color: theme.primary }]}>{formatDistance(totalKm, distanceUnit)}</Text>
          <Text style={[styles.distanceSubtext, { color: theme.textSecondary }]}>total distance</Text>
        </View>
        {comparison.passedLandmark && (
          <View style={[styles.landmark, { borderColor: theme.primary }]}>
            <MaterialCommunityIcons name={comparison.passedLandmark.icon} size={32} color={theme.primary} />
            <View style={styles.landmarkInfo}>
              <Text style={[styles.landmarkLabel, { color: theme.textSecondary }]}>You've travelled</Text>
              <Text style={[styles.landmarkName, { color: theme.text }]}>{comparison.passedLandmark.name}</Text>
            </View>
            <MaterialCommunityIcons name="check" size={24} color={theme.primary} />
          </View>
        )}
        {comparison.nextLandmark && (
          <View style={styles.nextLandmark}>
            <Text style={[styles.nextLandmarkLabel, { color: theme.textSecondary }]}>Next milestone:</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <MaterialCommunityIcons name={comparison.nextLandmark.icon} size={20} color={theme.textSecondary} />
              <Text style={[styles.nextLandmarkName, { color: theme.text }]}>
                {comparison.nextLandmark.name}
              </Text>
            </View>
            <View style={[styles.landmarkProgress, { backgroundColor: theme.surface }]}>
              <View style={[styles.landmarkProgressFill, { backgroundColor: theme.primary, width: `${Math.min(comparison.progress, 1) * 100}%` }]} />
            </View>
            <Text style={[styles.landmarkProgressText, { color: theme.textSecondary }]}>
              {formatDistance(totalKm, distanceUnit)} / {formatDistance(comparison.nextLandmark.distance, distanceUnit)}
            </Text>
          </View>
        )}
      </View>
    );
  };

  // --- Challenges Card (random/auto) ---
  const renderChallengesCard = () => {
    if (!gamification?.challenges) return null;
    const activeChallenges = gamification.challenges.filter(c => !c.expired && !c.completed);
    const completedChallenges = gamification.challenges.filter(c => c.completed);
    return (
      <View style={[styles.challengesCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.challengesHeader}>
          <TargetIcon size={20} color={theme.accent} />
          <Text style={[styles.challengesTitle, { color: theme.text }]}>Challenges</Text>
          <Text style={[styles.challengesCount, { color: theme.textSecondary }]}>
            {completedChallenges.length}/{gamification.challenges.length}
          </Text>
        </View>
        {activeChallenges.slice(0, 3).map(challenge => (
          <View key={challenge.id} style={[styles.challenge, { backgroundColor: theme.surface }]}>
            <Text style={[styles.challengeDesc, { color: theme.text }]}>{challenge.description}</Text>
            <Text style={[styles.challengeProgress, { color: theme.textSecondary }]}>
              {typeof challenge.progress === 'number' ? challenge.progress.toFixed(1) : '0'} / {challenge.target} {challenge.unit}
            </Text>
            <View style={[styles.challengeBar, { backgroundColor: theme.border }]}>
              <View style={[styles.challengeBarFill, { backgroundColor: theme.accent, width: `${Math.min((challenge.progress || 0) / challenge.target, 1) * 100}%` }]} />
            </View>
          </View>
        ))}
        {completedChallenges.slice(0, 2).map(challenge => (
          <View key={challenge.id} style={[styles.challenge, { backgroundColor: theme.primaryLight }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <MaterialCommunityIcons name="check-circle-outline" size={16} color={theme.primary} />
              <Text style={[styles.challengeDesc, { color: theme.primary }]}>{challenge.description}</Text>
            </View>
          </View>
        ))}
        <TouchableOpacity style={[styles.viewAllButton, { backgroundColor: theme.surface }]} onPress={() => setActiveTab('challenges')}>
          <Text style={[styles.viewAllText, { color: theme.primary }]}>View All Challenges</Text>
          <ChevronRightIcon size={18} color={theme.primary} />
        </TouchableOpacity>
      </View>
    );
  };

  // --- Selected Challenge Card ---
  const renderSelectedChallengeCard = () => {
    if (!selectedChallenge) {
      return (
        <View style={[styles.challengesCard, { backgroundColor: theme.cardBg }]}>
          <View style={styles.challengesHeader}>
            <MaterialCommunityIcons name="target" size={20} color={theme.accent} />
            <Text style={[styles.challengesTitle, { color: theme.text }]}>Selected Challenge</Text>
          </View>
          <Text style={[styles.challengeDesc, { color: theme.textSecondary, marginBottom: 12 }]}>No challenge selected. Pick one for bonus XP!</Text>
          <TouchableOpacity style={[styles.viewAllButton, { backgroundColor: theme.accent }]} onPress={() => setShowChallengePicker(true)}>
            <MaterialCommunityIcons name="plus" size={18} color="#fff" />
            <Text style={[styles.viewAllText, { color: '#fff' }]}>Choose Challenge</Text>
          </TouchableOpacity>
        </View>
      );
    }
    const progressPct = Math.min((selectedChallenge.progress || 0) / selectedChallenge.target, 1) * 100;
    return (
      <View style={[styles.challengesCard, { backgroundColor: theme.cardBg, borderLeftColor: theme.accent, borderLeftWidth: 3 }]}>
        <View style={styles.challengesHeader}>
          <MaterialCommunityIcons name="target" size={20} color={theme.accent} />
          <Text style={[styles.challengesTitle, { color: theme.text }]}>Selected Challenge</Text>
          {selectedChallenge.completed ? (
            <MaterialCommunityIcons name="check-circle" size={20} color={theme.success || '#4CAF50'} />
          ) : (
            <TouchableOpacity onPress={() => setShowAbandonConfirm(true)}>
              <MaterialCommunityIcons name="close" size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <View style={[styles.challenge, { backgroundColor: selectedChallenge.completed ? theme.primaryLight : theme.surface }]}>
          <Text style={[styles.challengeDesc, { color: selectedChallenge.completed ? theme.primary : theme.text }]}>
            {selectedChallenge.completed ? '* ' : ''}{selectedChallenge.description}
          </Text>
          {!selectedChallenge.completed && (
            <>
              <Text style={[styles.challengeProgress, { color: theme.textSecondary }]}>
                {typeof selectedChallenge.progress === 'number' ? selectedChallenge.progress.toFixed(1) : '0'} / {selectedChallenge.target} {selectedChallenge.unit}
              </Text>
              <View style={[styles.challengeBar, { backgroundColor: theme.border }]}>
                <View style={[styles.challengeBarFill, { backgroundColor: theme.accent, width: `${progressPct}%` }]} />
              </View>
            </>
          )}
          {selectedChallenge.completed && (
            <Text style={[styles.challengeProgress, { color: theme.primary }]}>+{selectedChallenge.bonusXp} XP earned!</Text>
          )}
        </View>
        {!selectedChallenge.completed && (
          <Text style={[{ color: theme.textSecondary, fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 }]}>
            Progress counts from selection point. Bonus: +{selectedChallenge.bonusXp} XP
          </Text>
        )}
        {selectedChallenge.completed && (
          <TouchableOpacity style={[styles.viewAllButton, { backgroundColor: theme.accent }]} onPress={() => setShowChallengePicker(true)}>
            <MaterialCommunityIcons name="plus" size={18} color="#fff" />
            <Text style={[styles.viewAllText, { color: '#fff' }]}>Choose Another Challenge</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  // --- Challenge Picker Modal ---
  const renderChallengePicker = () => {
    // Get offerable challenges, filtered to exclude in-flight and already-achieved
    const autoChallenges = gamification?.challenges?.filter(c => !c.expired && !c.completed) || [];
    const offerable = getOfferableChallenges(activities, selectedChallenge, autoChallenges, gamification?.stats?.currentStreak || 0);
    
    if (offerable.length === 0) {
      return (
        <Modal visible={showChallengePicker} transparent={true} animationType="slide" onRequestClose={() => setShowChallengePicker(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { backgroundColor: theme.cardBg, padding: 24 }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: theme.text }]}>Choose a Challenge</Text>
                <TouchableOpacity onPress={() => setShowChallengePicker(false)}>
                  <MaterialCommunityIcons name="close" size={24} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={[{ color: theme.textSecondary, fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', padding: 20 }]}>
                No challenges available right now. All active challenges are in progress or already completed!
              </Text>
            </View>
          </View>
        </Modal>
      );
    }
    
    return (
      <Modal visible={showChallengePicker} transparent={true} animationType="slide" onRequestClose={() => setShowChallengePicker(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Choose a Challenge</Text>
              <TouchableOpacity onPress={() => setShowChallengePicker(false)}>
                <MaterialCommunityIcons name="close" size={24} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>
            <Text style={[{ color: theme.textSecondary, fontSize: 13, fontFamily: 'Inter_400Regular', marginBottom: 12 }]}>
              Progress starts now, not retroactive. Complete it for bonus XP!
            </Text>
            <ScrollView style={{ maxHeight: 400 }}>
              {offerable.map(challengeDef => {
                const isActive = selectedChallenge &&
                  selectedChallenge.templateId === challengeDef.templateId &&
                  selectedChallenge.target === challengeDef.target && !selectedChallenge.completed;
                return (
                  <TouchableOpacity
                    key={`${challengeDef.templateId}_${challengeDef.target}`}
                    style={[styles.challenge, { backgroundColor: isActive ? theme.primaryLight : theme.surface, opacity: isActive ? 0.6 : 1 }]}
                    disabled={isActive}
                    onPress={async () => {
                      if (selectedChallenge && !selectedChallenge.completed) {
                        setShowChallengePicker(false);
                        setShowAbandonConfirm(true);
                        return;
                      }
                      await selectChallenge(challengeDef.templateId, challengeDef.target);
                      setShowChallengePicker(false);
                      loadData();
                    }}
                  >
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.challengeDesc, { color: theme.text }]}>{challengeDef.description}</Text>
                        <Text style={[{ color: theme.textSecondary, fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 }]}>
                          +{challengeDef.bonusXp} XP bonus
                        </Text>
                      </View>
                      {isActive ? (
                        <MaterialCommunityIcons name="check" size={20} color={theme.primary} />
                      ) : (
                        <MaterialCommunityIcons name="chevron-right" size={20} color={theme.textSecondary} />
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    );
  };
const renderAbandonConfirm = () => {
    return (
      <Modal visible={showAbandonConfirm} transparent={true} animationType="fade" onRequestClose={() => setShowAbandonConfirm(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.cardBg, padding: 24 }]}>
            <MaterialCommunityIcons name="alert-outline" size={40} color={theme.warning || '#FF9800'} style={{ alignSelf: 'center', marginBottom: 12 }} />
            <Text style={[{ color: theme.text, fontSize: 18, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: 8 }]}>Abandon Challenge?</Text>
            <Text style={[{ color: theme.textSecondary, fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', marginBottom: 20 }]}>
              Your current progress will be lost.
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity style={[{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: theme.surface }]} onPress={() => setShowAbandonConfirm(false)}>
                <Text style={[{ color: theme.text, textAlign: 'center', fontFamily: 'Inter_600SemiBold' }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[{ flex: 1, padding: 12, borderRadius: 12, backgroundColor: theme.danger || '#EF5350' }]} onPress={async () => {
                await abandonSelectedChallenge();
                setShowAbandonConfirm(false);
                setSelectedChallenge(null);
                setShowChallengePicker(true);
              }}>
                <Text style={[{ color: '#fff', textAlign: 'center', fontFamily: 'Inter_600SemiBold' }]}>Abandon</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    );
  };

  // --- Full Challenges View ---
  const renderChallengesView = () => {
    if (!gamification?.challenges) return null;
    const inProgressChallenges = gamification.challenges.filter(c => !c.expired && !c.completed && (c.progress || 0) > 0);
    const availableChallenges = gamification.challenges.filter(c => !c.expired && !c.completed && (c.progress || 0) === 0);
    const completedChallenges = gamification.challenges.filter(c => c.completed);
    const expiredChallenges = gamification.challenges.filter(c => c.expired && !c.completed);
    return (
      <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.achievementsViewHeader}>
          <TouchableOpacity style={[styles.backButton, { backgroundColor: theme.surface }]} onPress={() => setActiveTab('overview')}>
            <MaterialCommunityIcons name="arrow-left" size={16} color={theme.primary} />
            <Text style={[styles.backButtonText, { color: theme.primary }]}>Back</Text>
          </TouchableOpacity>
          <Text style={[styles.achievementsViewTitle, { color: theme.text }]}>Challenges</Text>
          <View style={styles.backButton} />
        </View>
        {inProgressChallenges.length > 0 && (
          <View style={styles.achievementCategory}>
            <Text style={[styles.categoryTitle, { color: theme.text }]}>In Progress</Text>
            {inProgressChallenges.map(challenge => (
              <View key={challenge.id} style={[styles.challengeRowLarge, { backgroundColor: theme.cardBg }]}>
                <View style={[styles.challengeIconLarge, { backgroundColor: theme.surface }]}>
                  <TargetIcon size={32} color={theme.accent} />
                </View>
                <View style={styles.challengeRowInfo}>
                  <Text style={[styles.challengeRowDesc, { color: theme.text }]}>{challenge.description}</Text>
                  <Text style={[styles.challengeRowProgress, { color: theme.textSecondary }]}>
                    {typeof challenge.progress === 'number' ? challenge.progress.toFixed(1) : '0'} / {challenge.target} {challenge.unit}
                  </Text>
                  <View style={[styles.challengeBarLarge, { backgroundColor: theme.border }]}>
                    <View style={[styles.challengeBarFill, { backgroundColor: theme.accent, width: `${Math.min((challenge.progress || 0) / challenge.target, 1) * 100}%` }]} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
        {completedChallenges.length > 0 && (
          <View style={styles.achievementCategory}>
            <Text style={[styles.categoryTitle, { color: theme.text }]}>Completed</Text>
            {completedChallenges.map(challenge => (
              <View key={challenge.id} style={[styles.challengeRowLarge, { backgroundColor: theme.cardBg, borderLeftColor: theme.primary, borderLeftWidth: 4 }]}>
                <View style={[styles.challengeIconLarge, { backgroundColor: theme.primaryLight }]}>
                  <MaterialCommunityIcons name="check" size={32} color={theme.primary} />
                </View>
                <View style={styles.challengeRowInfo}>
                  <Text style={[styles.challengeRowDesc, { color: theme.primary }]}>{challenge.description}</Text>
                  <Text style={[styles.challengeRowProgress, { color: theme.textSecondary }]}>+25 XP earned</Text>
                </View>
              </View>
            ))}
          </View>
        )}
        {availableChallenges.length > 0 && (
          <View style={styles.achievementCategory}>
            <Text style={[styles.categoryTitle, { color: theme.text }]}>Available</Text>
            {availableChallenges.map(challenge => (
              <View key={challenge.id} style={[styles.challengeRowLarge, { backgroundColor: theme.cardBg }]}>
                <View style={[styles.challengeIconLarge, { backgroundColor: theme.surface }]}>
                  <TargetIcon size={32} color={theme.textSecondary} />
                </View>
                <View style={styles.challengeRowInfo}>
                  <Text style={[styles.challengeRowDesc, { color: theme.text }]}>{challenge.description}</Text>
                  <Text style={[styles.challengeRowProgress, { color: theme.textSecondary }]}>
                    0 / {challenge.target} {challenge.unit}
                  </Text>
                  <View style={[styles.challengeBarLarge, { backgroundColor: theme.border }]}>
                    <View style={[styles.challengeBarFill, { backgroundColor: theme.accent, width: '0%' }]} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
        {expiredChallenges.length > 0 && (
          <View style={styles.achievementCategory}>
            <Text style={[styles.categoryTitle, { color: theme.text }]}>Expired</Text>
            {expiredChallenges.map(challenge => (
              <View key={challenge.id} style={[styles.challengeRowLarge, { backgroundColor: theme.cardBg, opacity: 0.6 }]}>
                <View style={[styles.challengeIconLarge, { backgroundColor: theme.surface }]}>
                  <MaterialCommunityIcons name="clock-outline" size={32} color={theme.textSecondary} />
                </View>
                <View style={styles.challengeRowInfo}>
                  <Text style={[styles.challengeRowDesc, { color: theme.textSecondary }]}>{challenge.description}</Text>
                  <Text style={[styles.challengeRowProgress, { color: theme.textSecondary }]}>
                    {typeof challenge.progress === 'number' ? challenge.progress.toFixed(1) : '0'} / {challenge.target} {challenge.unit}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
    );
  };

  // --- Achievements Card ---
  const renderAchievementsCard = () => {
    if (!gamification) return null;
    const achievementList = Object.values(ACHIEVEMENTS);
    return (
      <View style={[styles.achievementsCard, { backgroundColor: theme.cardBg }]}>
        <View style={styles.achievementsHeader}>
          <TrophyIcon size={20} color={theme.gold} />
          <Text style={[styles.achievementsTitle, { color: theme.text }]}>Achievements</Text>
          <Text style={[styles.achievementsCount, { color: theme.textSecondary }]}>
            {gamification.unlockedAchievements.length}/{achievementList.length}
          </Text>
        </View>
        <View style={styles.achievementsGrid}>
          {achievementList.slice(0, 8).map(achievement => {
            const isUnlocked = gamification.unlockedAchievements.includes(achievement.id);
            return (
              <TouchableOpacity
                key={achievement.id}
                style={[styles.achievementItem, { backgroundColor: theme.surface }, !isUnlocked && styles.achievementLocked]}
                onPress={() => { setSelectedAchievement(achievement); setShowAchievementModal(true); }}
              >
                {renderAchievementIcon(achievement.icon, 48, isUnlocked, achievement.tier, achievement.id)}
                {!isUnlocked && <View style={styles.achievementLockOverlay}><MaterialCommunityIcons name="lock-outline" size={16} color={theme.textSecondary} /></View>}
              </TouchableOpacity>
            );
          })}
        </View>
        <TouchableOpacity style={[styles.viewAllButton, { backgroundColor: theme.surface }]} onPress={() => setActiveTab('achievements')}>
          <Text style={[styles.viewAllText, { color: theme.primary }]}>View All Achievements</Text>
          <ChevronRightIcon size={18} color={theme.primary} />
        </TouchableOpacity>
      </View>
    );
  };

  // --- Full Achievements View ---
  const renderAchievementsView = () => {
    if (!gamification) return null;
    const categories = { general: 'General', streak: 'Streaks', walking: 'Walking', running: 'Running', biking: 'Mountain Biking' };
    return (
      <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.achievementsViewHeader}>
          <TouchableOpacity style={[styles.backButton, { backgroundColor: theme.surface }]} onPress={() => setActiveTab('overview')}>
            <MaterialCommunityIcons name="arrow-left" size={16} color={theme.primary} />
            <Text style={[styles.backButtonText, { color: theme.primary }]}>Back</Text>
          </TouchableOpacity>
          <Text style={[styles.achievementsViewTitle, { color: theme.text }]}>Achievements</Text>
          <View style={styles.backButton} />
        </View>
        {Object.entries(categories).map(([category, name]) => {
          const categoryAchievements = Object.values(ACHIEVEMENTS).filter(a => a.category === category);
          if (categoryAchievements.length === 0) return null;
          return (
            <View key={category} style={styles.achievementCategory}>
              <Text style={[styles.categoryTitle, { color: theme.text }]}>{name}</Text>
              {categoryAchievements.map(achievement => {
                const isUnlocked = gamification.unlockedAchievements.includes(achievement.id);
                return (
                  <TouchableOpacity
                    key={achievement.id}
                    style={[styles.achievementRow, { backgroundColor: theme.cardBg }, isUnlocked && { borderLeftColor: theme.primary, borderLeftWidth: 4 }]}
                    onPress={() => { setSelectedAchievement(achievement); setShowAchievementModal(true); }}
                  >
                    <View style={[styles.achievementRowIcon, { backgroundColor: isUnlocked ? theme.primaryLight : theme.surface }]}>
                      {renderAchievementIcon(achievement.icon, 40, isUnlocked, achievement.tier, achievement.id)}
                    </View>
                    <View style={styles.achievementRowInfo}>
                      <Text style={[styles.achievementRowName, { color: isUnlocked ? theme.text : theme.textSecondary }]}>{achievement.name}</Text>
                      <Text style={[styles.achievementRowDesc, { color: theme.textSecondary }]}>{achievement.description}</Text>
                    </View>
                    {isUnlocked
                      ? <MaterialCommunityIcons name="check" size={20} color={theme.primary} style={{ marginRight: 8 }} />
                      : <MaterialCommunityIcons name="lock-outline" size={16} color={theme.textSecondary} style={{ marginRight: 8 }} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}
        <View style={{ height: 30 }} />
      </ScrollView>
    );
  };

  // --- Achievement Modal ---
  const renderAchievementModal = () => (
    <Modal visible={showAchievementModal} transparent animationType="fade" onRequestClose={() => setShowAchievementModal(false)}>
      <View style={styles.modalOverlay}>
        <View style={[styles.achievementModalContent, { backgroundColor: theme.cardBg }]}>
          {selectedAchievement && (
            <>
              <View style={[styles.achievementModalIcon, { backgroundColor: theme.primaryLight }]}>
                {renderAchievementIcon(selectedAchievement.icon, 56, true, selectedAchievement.tier, selectedAchievement.id)}
              </View>
              <Text style={[styles.achievementModalName, { color: theme.text }]}>{selectedAchievement.name}</Text>
              <Text style={[styles.achievementModalDesc, { color: theme.textSecondary }]}>{selectedAchievement.description}</Text>
              <View style={[styles.achievementModalBadge, { backgroundColor: theme.primary }]}>
                <Text style={[styles.achievementModalBadgeText, { color: '#fff' }]}>
                  {gamification.unlockedAchievements.includes(selectedAchievement.id) ? 'Unlocked' : 'Locked'}
                </Text>
              </View>
              <TouchableOpacity style={[styles.achievementModalClose, { backgroundColor: theme.surface }]} onPress={() => setShowAchievementModal(false)}>
                <Text style={[styles.achievementModalCloseText, { color: theme.text }]}>Close</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );

  // --- Main Render ---
  if (activeTab === 'achievements') return renderAchievementsView();
  if (activeTab === 'challenges') return renderChallengesView();

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]}>
      {renderLevelCard()}
      {renderDistanceCard()}
      {renderChallengesCard()}
      {renderSelectedChallengeCard()}
      {renderAchievementsCard()}
      <View style={{ height: 30 }} />
      {renderAchievementModal()}
      {renderChallengePicker()}
      {renderAbandonConfirm()}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  levelCard: { margin: 16, marginBottom: 8, borderRadius: 16, padding: 16 },
  levelHeader: { flexDirection: 'row', alignItems: 'center' },
  levelIconContainer: { width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  levelInfo: { flex: 1, marginLeft: 12 },
  levelName: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  levelNumber: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  xpDisplayLarge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 16, borderRadius: 12 },
  xpValueLarge: { fontSize: 36, fontFamily: 'Inter_700Bold' },
  xpLabelLarge: { fontSize: 24, fontFamily: 'Inter_700Bold' },
  xpProgressContainer: { marginTop: 12 },
  xpProgressBar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  xpProgressFill: { height: '100%', borderRadius: 4 },
  xpProgressText: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4, textAlign: 'center' },
  streakBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, alignSelf: 'flex-start' },
  streakText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  distanceCard: { margin: 16, marginTop: 8, marginBottom: 8, borderRadius: 16, padding: 16 },
  distanceTitle: { fontSize: 14, fontFamily: 'Inter_700Bold', marginBottom: 8 },
  distanceMain: { alignItems: 'center', marginBottom: 12 },
  distanceValue: { fontSize: 36, fontFamily: 'Inter_700Bold' },
  distanceSubtext: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  landmark: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  landmarkInfo: { flex: 1, marginLeft: 12 },
  landmarkLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  landmarkName: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  nextLandmark: { marginTop: 4 },
  nextLandmarkLabel: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  nextLandmarkName: { fontSize: 14, fontFamily: 'Inter_700Bold', marginTop: 4, marginBottom: 8 },
  landmarkProgress: { height: 8, borderRadius: 4, overflow: 'hidden' },
  landmarkProgressFill: { height: '100%', borderRadius: 4 },
  landmarkProgressText: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 4 },
  challengesCard: { margin: 16, marginBottom: 8, borderRadius: 16, padding: 16 },
  challengesHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  challengesTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', flex: 1 },
  challengesCount: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  challenge: { padding: 12, borderRadius: 12, marginBottom: 8 },
  challengeDesc: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  challengeProgress: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2, marginBottom: 8 },
  challengeBar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  challengeBarFill: { height: '100%', borderRadius: 3 },
  challengeRowLarge: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 8 },
  challengeIconLarge: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  challengeRowInfo: { flex: 1, marginLeft: 12 },
  challengeRowDesc: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 4 },
  challengeRowProgress: { fontSize: 13, fontFamily: 'Inter_400Regular', marginBottom: 8 },
  challengeBarLarge: { height: 8, borderRadius: 4, overflow: 'hidden' },
  viewAllButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12, borderRadius: 12, marginTop: 4 },
  viewAllText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  achievementsCard: { margin: 16, marginBottom: 8, borderRadius: 16, padding: 16 },
  achievementsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  achievementsTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', flex: 1 },
  achievementsCount: { fontSize: 14, fontFamily: 'Inter_400Regular' },
  achievementsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  achievementItem: { width: 72, height: 72, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  achievementLocked: { opacity: 0.5 },
  achievementLockOverlay: { position: 'absolute', bottom: 4, right: 4 },
  achievementCategory: { padding: 16, paddingTop: 8 },
  categoryTitle: { fontSize: 18, fontFamily: 'Inter_700Bold', marginBottom: 12 },
  achievementRow: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 12, marginBottom: 8 },
  achievementRowIcon: { width: 56, height: 56, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  achievementRowInfo: { flex: 1, marginLeft: 12 },
  achievementRowName: { fontSize: 15, fontFamily: 'Inter_700Bold', marginBottom: 2 },
  achievementRowDesc: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  achievementsViewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  achievementsViewTitle: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  backButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, minWidth: 60, flexDirection: 'row', alignItems: 'center', gap: 4 },
  backButtonText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { width: '100%', maxWidth: 400, borderRadius: 20, padding: 20 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  modalTitle: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  achievementModalContent: { width: '100%', maxWidth: 300, borderRadius: 24, padding: 24, alignItems: 'center' },
  achievementModalIcon: { width: 100, height: 100, borderRadius: 50, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  achievementModalName: { fontSize: 20, fontFamily: 'Inter_700Bold', textAlign: 'center', marginBottom: 8 },
  achievementModalDesc: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', marginBottom: 16 },
  achievementModalBadge: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginBottom: 16 },
  achievementModalBadgeText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  achievementModalClose: { width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  achievementModalCloseText: { fontSize: 16, fontFamily: 'Inter_700Bold' },
  // Compact icon cluster for repeated-icon achievements (e.g. streak flames)
  iconCluster: { width: 48, height: 48, position: 'relative', alignItems: 'center', justifyContent: 'center' },
  clusterIcon: { position: 'absolute' },
  clusterTop: { top: 2, left: 11 },
  clusterBottomLeft: { bottom: 3, left: 2 },
  clusterBottomRight: { bottom: 3, right: 2 },
  clusterTwoLeft: { left: 4 },
  clusterTwoRight: { right: 4 },
});
