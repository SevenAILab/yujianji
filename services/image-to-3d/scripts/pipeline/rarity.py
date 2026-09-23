"""Rarity scoring with a conservative offline fallback."""
import re

THRESHOLDS = [(20, "common"), (45, "uncommon"), (70, "rare"),
              (88, "epic"), (101, "legendary")]


def score_rarity(commonness: int | float, first_seen: bool, reason: str) -> dict:
    if isinstance(commonness, bool) or not isinstance(commonness, (int, float)) or not 0 <= commonness <= 100:
        raise ValueError("commonness 必须为 0..100")
    if not isinstance(reason, str) or not reason.strip() or len(reason) > 160:
        raise ValueError("reason 无效")
    # No unsupported prevalence statistics or invented precision in user-facing copy.
    if re.search(r"\d|[％%]", reason):
        raise ValueError("reason 不得包含无来源统计数字")
    result = max(0, min(100, round(100 - commonness + (15 if first_seen else -30))))
    tier = next(name for ceiling, name in THRESHOLDS if result < ceiling)
    return {"tier": tier, "score": result, "reason": reason.strip()}


def fallback_rarity() -> dict:
    return {"tier": "uncommon", "score": 30, "reason": "暂未评级"}
