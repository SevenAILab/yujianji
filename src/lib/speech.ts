"use client";

import { LOCAL_ONLY } from "./app-mode";

export interface SpeechResult {
  finalText: string;
  interimText: string;
}

type SpeechRecognitionEventLike = Event & {
  results: ArrayLike<
    ArrayLike<{
      transcript: string;
    }>
  >;
  resultIndex: number;
};

export type SpeechRecognitionErrorLike = Event & {
  error?: string;
};

type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export function getSpeechRecognition(): SpeechRecognitionInstance | null {
  if (LOCAL_ONLY || typeof window === "undefined") return null;
  const Recognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition;
  return Recognition ? new Recognition() : null;
}

export function isSpeechRecognitionSupported(): boolean {
  if (LOCAL_ONLY || typeof window === "undefined") return false;
  return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
}

export function readSpeechResults(
  event: SpeechRecognitionEventLike,
): SpeechResult {
  let finalText = "";
  let interimText = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript ?? "";
    if (result && "isFinal" in result && result.isFinal) {
      finalText += transcript;
    } else {
      interimText += transcript;
    }
  }
  return { finalText, interimText };
}
