// Taper schedule configuration
// Started: March 10, 2026
const TAPER_START = new Date('2026-03-10T00:00:00');

const PHASES = [
  { week: 1,  label: 'Phase 1', mg: 6, intervalMin: 75, dailyTarget: 13, startDay: 0 },
  { week: 3,  label: 'Phase 2', mg: 4, intervalMin: 75, dailyTarget: 13, startDay: 14 },
  { week: 5,  label: 'Phase 3', mg: 4, intervalMin: 90, dailyTarget: 11, startDay: 28 },
  { week: 7,  label: 'Phase 4', mg: 2, intervalMin: 90, dailyTarget: 11, startDay: 42 },
  { week: 9,  label: 'Phase 5', mg: 2, intervalMin: 120, dailyTarget: 8, startDay: 56 },
  { week: 11, label: 'Phase 6', mg: 2, intervalMin: 180, dailyTarget: 5, startDay: 70 },
  { week: 13, label: 'Final',   mg: 1, intervalMin: 240, dailyTarget: 4, startDay: 84 },
];

function getDayNumber(date = new Date()) {
  const diff = date - TAPER_START;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getCurrentPhase(date = new Date()) {
  const day = getDayNumber(date);
  if (day < 0) return { ...PHASES[0], day, started: false };

  let current = PHASES[0];
  for (const phase of PHASES) {
    if (day >= phase.startDay) current = phase;
    else break;
  }

  // Calculate days until next phase
  const currentIdx = PHASES.indexOf(current);
  const nextPhase = PHASES[currentIdx + 1] || null;
  const daysUntilNext = nextPhase ? nextPhase.startDay - day : null;

  return {
    ...current,
    day,
    started: true,
    nextPhase,
    daysUntilNext,
    weekInPhase: Math.floor((day - current.startDay) / 7) + 1,
  };
}

function formatPhaseStatus(phase) {
  if (!phase.started) return `Taper starts ${TAPER_START.toLocaleDateString()}`;

  let msg = `Day ${phase.day + 1} | ${phase.label} | ${phase.mg}mg every ${phase.intervalMin}min | target: ${phase.dailyTarget}/day`;

  if (phase.daysUntilNext !== null && phase.daysUntilNext <= 3) {
    msg += `\n⚡ Step-down in ${phase.daysUntilNext} day${phase.daysUntilNext !== 1 ? 's' : ''} → ${phase.nextPhase.mg}mg every ${phase.nextPhase.intervalMin}min`;
  }

  return msg;
}

module.exports = { TAPER_START, PHASES, getDayNumber, getCurrentPhase, formatPhaseStatus };
