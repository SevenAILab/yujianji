export type Category =
  | "animal"
  | "plant"
  | "mineral"
  | "landscape"
  | "sky"
  | "food"
  | "artifact"
  | "other";

export type LocationSource =
  | "gps"
  | "exif"
  | "previous"
  | "default"
  | "manual"
  | "unavailable";

export type PlaceSource =
  | "voice"
  | "exif"
  | "manual"
  | "previous"
  | "default"
  | "gps"
  | "unavailable";

export type DateSource = "exif" | "fileModified" | "imported";

export type LuckConfidence = "low" | "medium" | "high";

export interface Luck {
  text: string;
  basis: string;
  confidence: LuckConfidence;
}

export interface RecognizedAi {
  cognition: string;
  fun: string;
  luck: Luck;
  question: string;
  verdict: "first" | "reunion";
  relatedItemId: string | null;
  memorySentence: string;
}

export interface Item {
  id: string;
  name: string;
  nameEn?: string;
  category: Category;
  photo: string;
  place: string;
  country: string;
  lat: number | null;
  lng: number | null;
  locationSource: LocationSource;
  placeSource?: PlaceSource;
  date: string;
  dateSource?: DateSource;
  userNote: string;
  heard?: string;
  ai: RecognizedAi | null;
  answer?: string;
  isSeed: boolean;
  createdAt: string;
}

export type DeviceSource = "manual" | "bluetooth-heart-rate" | "health-provider";

export interface HealthSnapshot {
  timestamp: string;
  heartRate?: number;
  bloodOxygen?: number;
  altitude?: number;
  steps?: number;
  source: DeviceSource;
  sampleId?: string;
  originId?: string;
  originName?: string;
  provider?: "health-connect" | "healthkit";
  endTimestamp?: string;
}

export interface NutritionEntry {
  id: string;
  timestamp: string;
  meal: string;
  calories?: number;
  waterMl?: number;
}

export interface TrackPoint {
  timestamp: string;
  lat: number;
  lng: number;
  altitude?: number;
  heading?: number;
  speed?: number;
}

export type TripStatus = "active" | "paused" | "completed";

export interface Trip {
  id: string;
  title: string;
  status: TripStatus;
  startedAt: string;
  endedAt?: string;
  trackPoints: TrackPoint[];
  healthSnapshots: HealthSnapshot[];
  nutrition: NutritionEntry[];
  panorama?: string;
  distanceMeters: number;
  elevationGainMeters: number;
  riskLevel: "low" | "medium" | "high";
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  name: string;
  category: Category;
  place: string;
  date: string;
  userNote: string;
}

export interface RecognizeSuccess {
  unrecognized: false;
  name: string;
  nameEn?: string;
  category: Category;
  cognition: string;
  fun: string;
  luck: Luck;
  question: string;
  verdict: "first" | "reunion";
  relatedItemId: string | null;
  memorySentence: string;
}

export interface RecognizeUnrecognized {
  unrecognized: true;
  observation: string;
  name: null;
  nameEn: null;
  category: null;
  cognition: null;
  fun: null;
  luck: null;
  question: null;
  verdict: null;
  relatedItemId: null;
  memorySentence: null;
}

export type RecognizeResult = RecognizeSuccess | RecognizeUnrecognized;

export interface RecognizeRequest {
  image: string;
  userNote: string;
  history: HistoryEntry[] | string;
}

export interface AvFrame {
  dataUrl: string;
  atSec: number;
}

export interface AvSegment extends RecognizeSuccess {
  frameIndex: number;
  heard: string;
  relatedItemName: string | null;
  matchBasis: string | null;
  matchConfidence: LuckConfidence | null;
  associationStatus: "confirmed" | "uncertain" | "none";
}

export type AvResult =
  | {
      recognized: false;
      placeHint: null;
      segments: [];
    }
  | {
      recognized: true;
      placeHint: string | null;
      segments: AvSegment[];
    };

export const CATEGORY_LABELS: Record<Category, string> = {
  animal: "动物",
  plant: "植物",
  mineral: "矿物",
  landscape: "风景",
  sky: "天空",
  food: "食物",
  artifact: "物件",
  other: "其他",
};

export const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS) as [
  Category,
  string,
][];
