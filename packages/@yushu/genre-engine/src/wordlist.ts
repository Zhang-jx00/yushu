/**
 * 四维词表（docs/05 §1，lint 强校验词表一致性）。
 * 词表是派系包 genre_axes 的合法取值来源；新增词须经 docs/05 §6 收录流程。
 */

export const CHANNELS: readonly string[] = ["男频", "女频", "纯爱", "百合", "无CP", "全性别"] as const;

export const WORLDS: readonly string[] = [
  "玄幻",
  "仙侠",
  "武侠",
  "西幻",
  "科幻",
  "超凡都市",
  "现实都市",
  "历史",
  "末世",
  "异世界",
  "民俗志怪",
  "游戏",
  "体育",
  "军事",
  "娱乐圈",
  "诸天无限",
  "轻小说",
] as const;

export const TECHNIQUES: readonly string[] = [
  "系统流",
  "穿越流",
  "重生流",
  "无限流",
  "快穿",
  "签到流",
  "直播流",
  "种田基建流",
  "规则怪谈",
  "幕后黑手流",
  "诸天流",
  "领主流",
  "苟道流",
  "马甲文",
  "团宠文",
  "赘婿流",
  "战神流",
  "神豪流",
  "神医流",
  "废柴流",
  "凡人流",
  "气运流",
  "宫斗宅斗",
  "第四天灾",
  "灵气复苏",
  "同人文",
] as const;

export const TONES: readonly string[] = [
  "爽文",
  "甜宠",
  "虐恋",
  "治愈",
  "轻松搞笑",
  "黑深残",
  "正剧",
  "热血",
] as const;

export const ROMANCE_MODES: readonly string[] = [
  "有女主",
  "无女主",
  "单CP",
  "多CP",
  "无CP",
  "后宫",
] as const;

export const WORDLIST: Record<string, readonly string[]> = {
  channel: CHANNELS,
  world: WORLDS,
  technique: TECHNIQUES,
  tone: TONES,
};