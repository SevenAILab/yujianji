"use client";

import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LOCAL_ONLY } from "@/lib/app-mode";
import {
  getSpeechRecognition,
  isSpeechRecognitionSupported,
  readSpeechResults,
} from "@/lib/speech";

interface VoiceButtonProps {
  value: string;
  onChange: (value: string) => void;
}

export function VoiceButton({ value, onChange }: VoiceButtonProps) {
  const recognitionRef = useRef<ReturnType<typeof getSpeechRecognition>>(null);
  const baseValueRef = useRef(value);
  const finalTranscriptRef = useRef("");
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported());
  }, []);

  function stop() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try {
        recognition.stop();
      } catch {
        recognition.abort?.();
      }
    }
    setListening(false);
    setInterim("");
  }

  function start() {
    const recognition = getSpeechRecognition();
    if (!recognition) {
      setSupported(false);
      setMessage("此浏览器不支持语音，请打字");
      return;
    }

    baseValueRef.current = value.trim();
    finalTranscriptRef.current = "";
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const result = readSpeechResults(event);
      finalTranscriptRef.current += result.finalText;
      const nextValue = [baseValueRef.current, finalTranscriptRef.current.trim()]
        .filter(Boolean)
        .join(" ");
      if (nextValue) {
        onChange(nextValue.slice(0, 300));
        if (nextValue.length > 300) setMessage("已达到 300 字上限");
      }
      setInterim(result.interimText);
    };
    recognition.onerror = (event) => {
      const errorMessage =
        event.error === "not-allowed"
          ? "麦克风权限未开启，请允许后再试"
          : event.error === "service-not-allowed"
            ? "此浏览器暂时不提供语音服务，请打字"
            : event.error === "network"
              ? "语音服务需要网络，请检查连接"
              : "没有听清，再试一次，或者直接打字";
      setMessage(errorMessage);
      stop();
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim("");
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
      setMessage("");
    } catch {
      setMessage("语音暂时无法启动，请直接打字");
      stop();
    }
  }

  useEffect(
    () => () => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onend = null;
        recognition.onerror = null;
        try {
          recognition.abort?.();
        } catch {
          // The browser may already have ended recognition during navigation.
        }
      }
    },
    [],
  );

  const hint = LOCAL_ONLY ? "离线模式关闭云端语音，请打字" : !supported
    ? "此浏览器不支持语音，请打字"
    : listening
      ? interim || "正在听…再点一次结束"
      : message || "可以说一句当时的话";

  return (
    <div className="voice-control">
      <button
        type="button"
        className={`voice-button ${listening ? "listening" : ""}`}
        onClick={() => (listening ? stop() : start())}
        disabled={!supported && !message}
        aria-label={listening ? "结束录音" : "开始语音输入"}
        title={hint}
      >
        {listening ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <span className={listening ? "voice-hint active" : "voice-hint"}>
        {hint}
      </span>
    </div>
  );
}
