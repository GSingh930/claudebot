/**
 * usageTracker.js
 * 
 * Tracks per-user token usage with daily limits.
 * Allowlisted users get full limits; everyone else gets a restricted daily cap.
 * Includes a scheduled cleanup job that wipes usage counters at midnight
 * and purges in-memory conversation history + any temp file references.
 */

// ── Allowlist from env var ─────────────────────────────────────────────────
// Set ALLOWED_USERS=123456789,987654321 in Railway Variables
// These are Discord user IDs (right-click user → Copy User ID)
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// ── Token limits ───────────────────────────────────────────────────────────
const LIMITS = {
  allowlisted: {
    maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_FULL)        || 4000,
    dailyTokenBudget:    parseInt(process.env.DAILY_TOKENS_FULL)      || 100_000,
  },
  restricted: {
    maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_RESTRICTED)  || 200,
    dailyTokenBudget:    parseInt(process.env.DAILY_TOKENS_RESTRICTED) || 500,
  },
};

// ── In-memory usage store: userId → { tokensUsedToday, lastReset } ─────────
const usageStore = new Map();

function getUsage(userId) {
  if (!usageStore.has(userId)) {
    usageStore.set(userId, { tokensUsedToday: 0, lastReset: todayKey() });
  }
  const entry = usageStore.get(userId);
  // Reset if it's a new day (belt-and-suspenders alongside the cron job)
  if (entry.lastReset !== todayKey()) {
    entry.tokensUsedToday = 0;
    entry.lastReset = todayKey();
  }
  return entry;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2025-04-23"
}

// ── Public API ─────────────────────────────────────────────────────────────

function isAllowlisted(userId) {
  return ALLOWED_USER_IDS.has(userId);
}

function getLimits(userId) {
  return isAllowlisted(userId) ? LIMITS.allowlisted : LIMITS.restricted;
}

/**
 * Check if a user is allowed to make a request.
 * Returns { allowed: true } or { allowed: false, reason: string, tokensLeft: number }
 */
function checkLimit(userId) {
  const limits = getLimits(userId);
  const usage  = getUsage(userId);
  const tokensLeft = limits.dailyTokenBudget - usage.tokensUsedToday;

  if (tokensLeft <= 0) {
    return {
      allowed: false,
      reason: isAllowlisted(userId)
        ? `⚠️ You've hit your daily token budget. Resets at midnight UTC.`
        : `🚫 You've used your daily message allowance (${limits.dailyTokenBudget} tokens). Resets at midnight UTC.\nContact a server admin to request full access.`,
      tokensLeft: 0,
    };
  }

  return { allowed: true, tokensLeft };
}

/**
 * Record token usage after a successful API call.
 * @param {string} userId
 * @param {number} tokensUsed - from response.usage.input_tokens + output_tokens
 */
function recordUsage(userId, tokensUsed) {
  const usage = getUsage(userId);
  usage.tokensUsedToday += tokensUsed;
  console.log(`[usage] ${userId} used ${tokensUsed} tokens today (total: ${usage.tokensUsedToday})`);
}

/**
 * Get a summary of a user's current usage for display.
 */
function getUsageSummary(userId) {
  const limits = getLimits(userId);
  const usage  = getUsage(userId);
  const pct    = Math.min(100, Math.round((usage.tokensUsedToday / limits.dailyTokenBudget) * 100));
  const tier   = isAllowlisted(userId) ? '✅ Full access' : '🔒 Restricted';
  return { tier, used: usage.tokensUsedToday, budget: limits.dailyTokenBudget, pct };
}

// ── Scheduled cleanup ──────────────────────────────────────────────────────
/**
 * startCleanupJob(conversationHistory, dmHistory)
 *
 * Runs two jobs:
 *  1. Every day at midnight UTC — reset all daily token counters and wipe
 *     ALL in-memory conversation history so no message content lingers.
 *  2. Every hour — evict conversation entries for users who haven't sent
 *     a message in > 2 hours (sliding window memory cleanup).
 */
function startCleanupJob(conversationHistory, dmHistory) {
  // ── Daily midnight reset ──
  function scheduleMidnightReset() {
    const now    = new Date();
    const next   = new Date(now);
    next.setUTCHours(24, 0, 0, 0); // next midnight UTC
    const msUntil = next - now;

    setTimeout(() => {
      console.log('[cleanup] 🕛 Midnight reset: wiping token usage + all conversation history');

      // Reset token counters
      for (const [, entry] of usageStore) {
        entry.tokensUsedToday = 0;
        entry.lastReset = todayKey();
      }

      // Wipe ALL in-memory histories — no message content survives the day
      conversationHistory.clear();
      dmHistory.clear();
      console.log('[cleanup] ✅ All conversation histories cleared');

      // Schedule next day
      scheduleMidnightReset();
    }, msUntil);

    const h = Math.floor(msUntil / 3600000);
    const m = Math.floor((msUntil % 3600000) / 60000);
    console.log(`[cleanup] Next midnight reset in ${h}h ${m}m`);
  }

  // ── Hourly stale-session eviction ──
  function startHourlyEviction() {
    const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

    setInterval(() => {
      const now   = Date.now();
      let evicted = 0;

      for (const [key, session] of conversationHistory) {
        if (session.lastActivity && (now - session.lastActivity) > STALE_MS) {
          conversationHistory.delete(key);
          evicted++;
        }
      }

      for (const [key, session] of dmHistory) {
        if (session.lastActivity && (now - session.lastActivity) > STALE_MS) {
          dmHistory.delete(key);
          evicted++;
        }
      }

      if (evicted > 0) {
        console.log(`[cleanup] ♻️  Evicted ${evicted} stale sessions (inactive > 2h)`);
      }
    }, 60 * 60 * 1000); // every hour
  }

  scheduleMidnightReset();
  startHourlyEviction();

  console.log('[cleanup] Scheduled jobs started: midnight reset + hourly eviction');
}

module.exports = {
  isAllowlisted,
  getLimits,
  checkLimit,
  recordUsage,
  getUsageSummary,
  startCleanupJob,
  ALLOWED_USER_IDS,
};
