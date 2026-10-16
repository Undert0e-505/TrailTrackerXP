/**
 * Shared UI components for TrailTrackerXP.
 *
 * These are extracted from repeated inline patterns across screens.
 * They accept theme colours as props and preserve existing visual behaviour.
 *
 * Usage:
 *   import Card from './src/components/ui/Card';
 *   import SectionHeader from './src/components/ui/SectionHeader';
 *   import EmptyState from './src/components/ui/EmptyState';
 *   import StatRow from './src/components/ui/StatRow';
 *   import Modal, { ModalOverlay, ModalButton } from './src/components/ui/Modal';
 *   import AppScreen from './src/components/ui/AppScreen';
 *
 * Theme constants:
 *   import { SCREEN_PADDING, CARD_RADIUS } from './src/theme/spacing';
 *   import { FONT, FONT_SIZE, TEXT_STYLES } from './src/theme/typography';
 */

export { default as AppScreen } from './AppScreen';
export { default as Card } from './Card';
export { default as SectionHeader } from './SectionHeader';
export { default as StatRow, StatItem } from './StatRow';
export { default as EmptyState } from './EmptyState';
export { default as Modal, ModalOverlay, ModalButton, ModalTitle, ModalMessage } from './Modal';
