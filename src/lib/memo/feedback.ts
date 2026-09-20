// 反馈事件的语义（spec v3 §4.8 反馈语义表）。页面、学习、实验室都按这张表解释用户操作。
import type { FeedbackEvent, FeedbackType, Moment } from "./types";

export interface FeedbackEffect {
  label: string;
  currentDiary: string;
  nextWrite: string;
  profile: string;
  judgeExample: string;
  eval: string;
}

export const FEEDBACK_EFFECTS: Record<FeedbackType, FeedbackEffect> = {
  delete: {
    label: "删掉一段",
    currentDiary: "立即从正文和折叠区隐藏；5 秒内可撤销（撤销直接删掉这条事件，不算反馈）",
    nextWrite: "重新生成时不再入选",
    profile: "反思的证据：这类不该留",
    judgeExample: "作为「删掉」的例子进入之后的判断",
    eval: "不影响（测试集固定）",
  },
  restore: {
    label: "从折叠区捞回",
    currentDiary: "立即加入正文，先显示整理后的原话（未润色），重新生成时再写",
    nextWrite: "一定入选，不受 salience 和 15 分钟间隔限制；说话人拿不准的片段捞回即视为确认是你说的",
    profile: "反思的证据：这类该留（漏判了）",
    judgeExample: "作为「捞回」的例子进入之后的判断",
    eval: "不影响",
  },
  copy: {
    label: "复制段落或金句",
    currentDiary: "不变，只记次数",
    nextWrite: "不影响",
    profile: "弱证据：这段特别好（类型和文风偏好）",
    judgeExample: "作为「复制」的例子，排在删掉和捞回之后",
    eval: "不影响",
  },
  edit: {
    label: "改了措辞",
    currentDiary: "显示你改后的文字，标「你改过」",
    nextWrite: "保留你改后的文字，不再重写这一段",
    profile: "反思的证据：文风偏好（带改前改后）",
    judgeExample: "不进判断（改的是写法，不是留不留）",
    eval: "不影响",
  },
};

/** 把一条事件落到片段的用户状态上（纯函数，调用方和事件写入放在同一个事务里） */
export function applyFeedback(moment: Pick<Moment, "user" | "speakerUncertain">, event: FeedbackEvent): Moment["user"] {
  const user = { ...moment.user };
  switch (event.type) {
    case "delete":
      user.decision = "drop";
      break;
    case "restore":
      user.decision = "keep";
      if (moment.speakerUncertain) user.speakerConfirmed = true;
      break;
    case "copy":
      user.copiedCount = (user.copiedCount ?? 0) + 1;
      break;
    case "edit":
      user.editedText = event.after;
      user.editedAt = event.at;
      break;
  }
  return user;
}

/** 撤销删除：只允许撤销还没被学习消费的删除 */
export function canUndoDelete(event: FeedbackEvent): boolean {
  return event.type === "delete" && event.consumedByVersion === undefined;
}

export function isLearningSignal(event: FeedbackEvent): boolean {
  return event.consumedByVersion === undefined;
}
