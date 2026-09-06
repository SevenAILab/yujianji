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

  function detach(recognition: NonNullable<ReturnType<typeof getSpeechRecognition>>) {
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
  }

  function stop() {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      // 关键：不能在 stop() 之前摘掉 onresult。
      // stop() 的语义是「停止收音，但把已缓冲的音频处理完，
      // 并派发最后一次 isFinal 结果」——最后一句话正是靠它落地的。
      // 之前提前摘掉 handler，说完立刻点停止就会丢掉最后一段，
      // 而说完停顿一下（浏览器已自行 finalize 过）就没事，
      // 这就是「有时行有时不行」的来源。
      recognition.onerror = null;
      recognition.onend = () => {
        detach(recognition);
        setListening(false);
        setInterim("");
      };
      try {
        recognition.stop();
      } catch {
        detach(recognition);
        try {
          recognition.abort?.();
        } catch {
          // 浏览器可能已经自己结束了识别。
        }
        setListening(false);
        setInterim("");
      }
    } else {
      setListening(false);
      setInterim("");
    }
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
      // 连 interim 一起写进输入框：边说边出字，而且万一浏览器
      // 最后没补发 final，已经显示出来的那段也不会凭空消失。
      // 下一次 onresult 会用更完整的文本整体覆盖，不会重复累加。
      const spoken = `${finalTranscriptRef.current}${result.interimText}`.trim();
      const nextValue = [baseValueRef.current, spoken].filter(Boolean).join(" ");
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
