import { useRef, useState } from "react";

interface SpeechRec {
  start: () => void;
  stop: () => void;
  abort?: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getSR(): (new () => SpeechRec) | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice(onText: (t: string) => void) {
  const [listening, setListening] = useState(false);
  const [supported] = useState(() => !!getSR());
  const recRef = useRef<SpeechRec | null>(null);

  const start = () => {
    const SR = getSR();
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e) => {
      let chunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) chunk += r[0].transcript;
      }
      if (chunk) onText(chunk);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    recRef.current = rec;
    setListening(true);
  };

  const stop = () => {
    recRef.current?.stop();
    setListening(false);
  };

  return { supported, listening, start, stop };
}
