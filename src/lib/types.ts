export type Category =
  | "animal"
  | "plant"
  | "mineral"
  | "landscape"
  | "sky"
  | "food"
  | "artifact"
  | "other";

export type LocationSource = "gps" | "previous" | "default" | "manual";

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
  lat: number;
  lng: number;
  locationSource: LocationSource;
  date: string;
  userNote: string;
  ai: RecognizedAi | null;
  answer?: string;
  isSeed: boolean;
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
