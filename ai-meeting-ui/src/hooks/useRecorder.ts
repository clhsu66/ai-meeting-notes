// src/hooks/useRecorder.ts
import { useEffect, useRef, useState } from "react";

interface UseRecorderResult {
  isRecording: boolean;
  isPaused: boolean;
  elapsedSeconds: number;
  audioBlob: Blob | null;
  start: () => Promise<void>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
}

export function useRecorder(): UseRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimestampRef = useRef<number | null>(null);
  const accumulatedMsRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = () => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setInterval(() => {
      let totalMs = accumulatedMsRef.current;
      if (startTimestampRef.current !== null) {
        totalMs += Date.now() - startTimestampRef.current;
      }
      setElapsedSeconds(Math.floor(totalMs / 1000));
    }, 500);
  };

  const start = async () => {
    if (isRecording) return;

    // clear previous recording
    setAudioBlob(null);
    chunksRef.current = [];
    accumulatedMsRef.current = 0;
    startTimestampRef.current = null;
    setElapsedSeconds(0);
    setIsPaused(false);

    // ask for microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const options: MediaRecorderOptions = {};
    // Prefer opus if supported
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      options.mimeType = "audio/webm;codecs=opus";
    } else if (MediaRecorder.isTypeSupported("audio/webm")) {
      options.mimeType = "audio/webm";
    }

    const recorder = new MediaRecorder(stream, options);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };

    recorder.onstop = () => {
      if (chunksRef.current.length > 0) {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
      } else {
        setAudioBlob(null);
      }
      chunksRef.current = [];

      // stop mic tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };

    recorder.start();
    startTimestampRef.current = Date.now();
    startTimer();
    setIsRecording(true);
  };

  const stop = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    setIsRecording(false);
    setIsPaused(false);

    if (startTimestampRef.current !== null) {
      accumulatedMsRef.current += Date.now() - startTimestampRef.current;
      startTimestampRef.current = null;
    }
    clearTimer();
    accumulatedMsRef.current = 0;
  };

  const pause = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    if (startTimestampRef.current !== null) {
      accumulatedMsRef.current += Date.now() - startTimestampRef.current;
      startTimestampRef.current = null;
    }
    setIsPaused(true);
  };

  const resume = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    startTimestampRef.current = Date.now();
    setIsPaused(false);
    startTimer();
  };

  // cleanup on unmount
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      clearTimer();
    };
  }, []);

  return { isRecording, isPaused, elapsedSeconds, audioBlob, start, stop, pause, resume };
}
