export type JourneyPhotoPresentation = "subject" | "polaroid";

export type JourneyRegionGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface JourneyCollageRegion {
  id: string;
  name: string;
  country: string;
  geometry: JourneyRegionGeometry;
}

export interface JourneyCollageStop {
  id: string;
  itemId: string;
  date: string;
  place: string;
  detail: string;
  note: string;
  photo: string;
  coordinates: [number, number];
  hasDetectedSubject: boolean;
}

export interface JourneyCollageData {
  id: string;
  regions: JourneyCollageRegion[];
  mapLabel: string;
  stops: JourneyCollageStop[];
}

export const JOURNEY_COLLAGE_RULES = {
  photoPresentation: "全部使用原始照片并沿用既有拍立得相框与拼贴位置，不再进行人物或物体抠图。",
  geography: "地图按旅程地点所属的一级行政区裁切；跨省旅程合并展示涉及区域，只显示真实陆地边界，不填充海面颜色。",
  route: "按地点时间顺序生成平滑曲线，路线可以被照片或便签遮挡。",
  locationPriority: "地点圆点与地点名称始终位于最高视觉层，不允许被地图、路线、照片或便签遮挡。",
  interaction: "点击地点、照片或便签时，将该地点对应的照片和便签一起提升到拼贴顶层，不弹出覆盖地图的内容框。",
  layout: "地点数量不设上限。照片与便签按预设槽位循环叠放，照片优先大尺寸并形成纸片堆栈；地点圆点和名称永远位于所有堆栈之上。",
} as const;

export function getPhotoPresentation(hasDetectedSubject: boolean): JourneyPhotoPresentation {
  void hasDetectedSubject;
  return "polaroid";
}
