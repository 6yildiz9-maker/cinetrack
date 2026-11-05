// ===========================================================================
// Cinethos Taste Engine — Behavior Signals (v1.0)
// Kullanıcı davranışlarını [-1, +1] aralığında sinyallere dönüştürür (TP-015/017/019)
// ===========================================================================

import { BEHAVIOR_SIGNALS } from "./constants.ts";

export type BehaviorSignalInput =
  | { type: "rating"; value: number; source?: "numeric" | "quick" }
  | { type: "quick_feedback"; value: "like" | "neutral" | "dislike" }
  | { type: "intent"; value: "watchlist" | "watching" }
  | { type: "watched_no_rating" }
  | { type: "not_interested" }
  | { type: "hidden" }
  | { type: "abandoned"; reason?: "disliked" | "time" | "access" | "paused" };

export interface BehaviorSignalResult {
  signal: number;       // [-1, +1]
  isEvidence: boolean;  // kanıt sayacına girer mi?
  ratingSource?: "numeric" | "quick";
  category: "positive" | "negative" | "neutral" | "intent" | "exclusion";
}

export function computeBehaviorSignal(input: BehaviorSignalInput): BehaviorSignalResult {
  switch (input.type) {
    case "rating": {
      const rating = input.value;
      let signal: number;
      if (rating >= 9 && rating <= 10)      signal = BEHAVIOR_SIGNALS.rating_9_10;
      else if (rating >= 8 && rating < 9)   signal = BEHAVIOR_SIGNALS.rating_8_89;
      else if (rating >= 7 && rating < 8)   signal = BEHAVIOR_SIGNALS.rating_7_79;
      else if (rating >= 5 && rating < 7)   signal = BEHAVIOR_SIGNALS.rating_5_69;
      else if (rating >= 3 && rating < 5)   signal = BEHAVIOR_SIGNALS.rating_3_49;
      else if (rating >= 1 && rating < 3)   signal = BEHAVIOR_SIGNALS.rating_1_29;
      else signal = 0; // geçersiz puan

      return {
        signal,
        isEvidence: true,
        ratingSource: input.source ?? "numeric",
        category: signal > 0 ? "positive" : signal < 0 ? "negative" : "neutral",
      };
    }

    case "quick_feedback": {
      const signal =
        input.value === "like"
          ? BEHAVIOR_SIGNALS.quick_like
          : input.value === "dislike"
          ? BEHAVIOR_SIGNALS.quick_dislike
          : BEHAVIOR_SIGNALS.quick_neutral;
      return {
        signal,
        isEvidence: true,
        ratingSource: "quick",
        category: signal > 0 ? "positive" : signal < 0 ? "negative" : "neutral",
      };
    }

    case "intent": {
      const signal =
        input.value === "watchlist"
          ? BEHAVIOR_SIGNALS.watchlist
          : BEHAVIOR_SIGNALS.watching;
      return {
        signal,
        isEvidence: false, // niyet katmanı, kanıt sayacına girmez
        category: "intent",
      };
    }

    case "watched_no_rating": {
      return {
        signal: 0,
        isEvidence: false, // kanıt değil
        category: "neutral",
      };
    }

    case "not_interested": {
      return {
        signal: 0,
        isEvidence: false, // öneri kontrolü, negatif tercih değil
        category: "exclusion",
      };
    }

    case "hidden": {
      return {
        signal: 0,
        isEvidence: false, // kesin dışlama, sinyal üretmez
        category: "exclusion",
      };
    }

    case "abandoned": {
      const reason = input.reason ?? "disliked";
      const signal =
        reason === "disliked"
          ? BEHAVIOR_SIGNALS.abandoned_disliked
          : reason === "time" || reason === "access"
          ? BEHAVIOR_SIGNALS.abandoned_time
          : BEHAVIOR_SIGNALS.abandoned_paused;
      return {
        signal,
        isEvidence: reason === "disliked", // yalnızca beğenmedim negatif kanıt
        category: signal < 0 ? "negative" : signal > 0 ? "positive" : "neutral",
      };
    }

    default:
      return { signal: 0, isEvidence: false, category: "neutral" };
  }
}
